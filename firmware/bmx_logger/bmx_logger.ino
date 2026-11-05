/*
  BMX Gearing Logger - ESP32 firmware (prototype)
  ------------------------------------------------
  Board  : ESP32 Dev Module (ESP-WROOM-32, 4 MB flash)
  Core   : arduino-esp32 2.x or 3.x
  Extras : NimBLE-Arduino 2.5.1 (h2zero, install from Library Manager)

  What it does
  - Auto-detects an MPU-6050 (or MPU-6500 family) or an LSM6DSO32 on I2C.
  - Samples the motion sensor at a fixed rate (default 250 Hz).
  - Timestamps every wheel and crank magnet pulse in an interrupt.
  - Records runs into pre-erased flash "slots" so writes never stall sampling
    for long (no filesystem, no SD card).
  - Talks to the phone app over Bluetooth Low Energy (Chrome on Android). No Wi-Fi: the radio
    stays off, which saves power and avoids the start-up current spike.

  Wiring (see design doc for details)
    IMU SDA -> GPIO21, SCL -> GPIO22, VCC -> 3V3, GND -> GND
    Wheel magnet sensor signal -> GPIO32 (active low)
    Crank magnet sensor signal -> GPIO33 (active low)
    Optional button GPIO27 -> GND (arm / stop)
    Status LED = onboard GPIO2

  IMPORTANT: keep partitions.csv in this sketch folder. It creates the "runs"
  flash area. Without it the app will show "runs partition missing".
*/

#include <Arduino.h>
#include <Wire.h>
#include <NimBLEDevice.h>
#include "ble_proto.h"
#include <Preferences.h>
#include "esp_partition.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/stream_buffer.h"

// ------------------------------------------------------------------ config

#define PIN_SDA     21
#define PIN_SCL     22
#define PIN_WHEEL   32
#define PIN_CRANK   33
#define PIN_BUTTON  27
#define PIN_LED     2

static const uint32_t SLOT_SIZE   = 0x50000;  // 320 KB per run (~68 s at 250 Hz)
static const uint32_t HEADER_SIZE = 64;
static const uint32_t REC_SIZE    = 16;
static const uint32_t RUN_MAGIC   = 0x4C584D42; // "BMXL"
static const uint32_t CRANK_LOCKOUT_US = 60000;  // ignore crank pulses closer than 60 ms
static const uint32_t WHEEL_LOCKOUT_US = 5000;   // ignore wheel pulses closer than 5 ms (comparator chatter)

enum RecType : uint32_t { REC_IMU = 0, REC_WHEEL = 1, REC_CRANK = 2, REC_MARK = 3 };
enum ImuType : uint8_t  { IMU_NONE = 0, IMU_MPU6050 = 1, IMU_LSM6DSO32 = 2 };
enum State   : uint8_t  { ST_IDLE = 0, ST_PREPARING, ST_RECORDING, ST_FINISHING };

struct __attribute__((packed)) RunHeader {
  uint32_t magic;
  uint16_t version;
  uint16_t headerSize;
  uint32_t runId;
  uint16_t rateHz;
  uint8_t  imuType;
  uint8_t  flags;
  float    accLsbPerG;
  float    gyrLsbPerDps;
  uint32_t epoch;          // seconds, from phone clock (0 = unknown)
  uint8_t  wheelMagnets;
  uint8_t  crankMagnets;
  uint8_t  chainring;
  uint8_t  cog;
  uint16_t wheelCircMm;
  uint8_t  forwardAxis;    // 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z
  uint8_t  reserved0;
  char     label[20];
  uint32_t dataBytes;      // 0xFFFFFFFF until the run is closed
  uint32_t reserved1;
};
static_assert(sizeof(RunHeader) == 64, "header must be 64 bytes");

struct __attribute__((packed)) Rec {
  uint32_t tw;             // bits 0-29: microseconds since run start, bits 30-31: type
  int16_t  v[6];           // IMU: ax ay az gx gy gz (raw). Pulses/markers: zero
};
static_assert(sizeof(Rec) == 16, "record must be 16 bytes");

struct Settings {
  uint16_t wheelCircMm = 1515;   // 20x1.75 BMX tire; measure yours
  uint8_t  wheelMagnets = 2;
  uint8_t  crankMagnets = 1;
  uint8_t  chainring = 44;
  uint8_t  cog = 16;
  uint8_t  forwardAxis = 0;
  uint16_t rateHz = 250;
  uint8_t  autoStopS = 5;        // stop when wheel idle this long (0 = off)
} cfg;

// ------------------------------------------------------------------ globals
Preferences prefs;

static volatile uint8_t gState = ST_IDLE;
static volatile bool    gStopReq = false;
static volatile bool    gMarkReq = false;

static ImuType imuType = IMU_NONE;
static uint8_t imuAddr = 0;
static uint8_t imuWho = 0;
static float   accLsbPerG = 1, gyrLsbPerDps = 1;
static volatile uint32_t imuErrors = 0;
static volatile int16_t  latest[6];

static const esp_partition_t* runsPart = nullptr;
static uint32_t numSlots = 0;

static StreamBufferHandle_t recBuf = nullptr;
static TaskHandle_t samplerTask = nullptr;
static esp_timer_handle_t sampleTimer = nullptr;

// run in progress
static RunHeader curHdr;
static uint32_t curSlot = 0;
static volatile uint32_t runStartUs = 0;
static volatile uint32_t bytesQueued = 0;
static volatile uint32_t bytesWritten = 0;
static volatile uint32_t overflowCount = 0;
static volatile uint32_t runWheelPulses = 0;
static volatile uint32_t runCrankPulses = 0;
static char pendingLabel[20];
static uint32_t pendingEpoch = 0;
static String lastError;

// ------------------------------------------------------------------ pulses (ISR)
struct PulseRing {
  volatile uint32_t t[64];
  volatile uint32_t head = 0;
  uint32_t tail = 0;              // owned by sampler task
  volatile uint32_t count = 0;
  volatile uint32_t lastUs = 0;
  volatile uint32_t prevUs = 0;
  uint32_t lockoutUs = 0;
};
static PulseRing wheelP, crankP;

static void IRAM_ATTR onPulse(PulseRing& p) {
  uint32_t now = micros();
  if (p.count && (now - p.lastUs) < p.lockoutUs) return;   // bounce / noise
  p.prevUs = p.lastUs;
  p.lastUs = now;
  p.count = p.count + 1;
  uint32_t h = p.head;
  p.t[h & 63] = now;
  p.head = h + 1;
}
static void IRAM_ATTR wheelIsr() { onPulse(wheelP); }
static void IRAM_ATTR crankIsr() { onPulse(crankP); }

static float pulseRpm(PulseRing& p, uint8_t magnets) {
  uint32_t last = p.lastUs, prev = p.prevUs, now = micros();
  if (p.count < 2 || magnets == 0) return 0;
  if (now - last > 2000000UL) return 0;
  uint32_t per = last - prev;
  if (per == 0) return 0;
  return 60.0e6f / (float)per / (float)magnets;
}

// ------------------------------------------------------------------ I2C / IMU
static bool i2cWrite(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool i2cRead(uint8_t addr, uint8_t reg, uint8_t* buf, size_t len) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  int n = Wire.requestFrom((int)addr, (int)len);
  if (n != (int)len) return false;
  for (size_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

static bool initLsm(uint8_t a) {
  i2cWrite(a, 0x12, 0x01);            // CTRL3_C: software reset
  delay(20);
  bool ok = i2cWrite(a, 0x12, 0x44);  // CTRL3_C: BDU + auto-increment
  ok &= i2cWrite(a, 0x10, 0x64);      // CTRL1_XL: 416 Hz, +-32 g
  ok &= i2cWrite(a, 0x11, 0x6C);      // CTRL2_G : 416 Hz, +-2000 dps
  accLsbPerG = 1.0f / 0.000976f;      // 0.976 mg/LSB
  gyrLsbPerDps = 1.0f / 0.070f;       // 70 mdps/LSB
  return ok;
}

static bool initMpu(uint8_t a) {
  i2cWrite(a, 0x6B, 0x80);            // PWR_MGMT_1: reset
  delay(100);
  bool ok = i2cWrite(a, 0x6B, 0x01);  // clock = PLL gyro X
  ok &= i2cWrite(a, 0x1A, 0x02);      // DLPF ~94 Hz
  ok &= i2cWrite(a, 0x19, 0x03);      // 1 kHz / 4 = 250 Hz internal
  ok &= i2cWrite(a, 0x1B, 0x18);      // +-2000 dps
  ok &= i2cWrite(a, 0x1C, 0x18);      // +-16 g
  accLsbPerG = 2048.0f;
  gyrLsbPerDps = 16.4f;
  return ok;
}

static bool imuInit() {
  uint8_t who = 0;
  const uint8_t lsmAddrs[] = {0x6A, 0x6B};
  for (uint8_t a : lsmAddrs) {
    if (i2cRead(a, 0x0F, &who, 1) && who == 0x6C) {
      imuAddr = a;
      imuType = IMU_LSM6DSO32;
      return initLsm(a);
    }
  }
  const uint8_t mpuAddrs[] = {0x68, 0x69};
  for (uint8_t a : mpuAddrs) {
    if (i2cRead(a, 0x75, &who, 1) &&
        (who == 0x68 || who == 0x70 || who == 0x71 || who == 0x72 ||
         who == 0x73 || who == 0x98 || who == 0x19)) {
      imuAddr = a;
      imuWho = who;
      imuType = IMU_MPU6050;
      return initMpu(a);
    }
  }
  imuType = IMU_NONE;
  return false;
}

// out: ax ay az gx gy gz (raw counts)
static bool imuRead(int16_t out[6]) {
  uint8_t b[14];
  if (imuType == IMU_LSM6DSO32) {
    if (!i2cRead(imuAddr, 0x22, b, 12)) return false;   // gyro x,y,z then accel x,y,z
    for (int i = 0; i < 3; i++) {
      out[3 + i] = (int16_t)(b[2 * i] | (b[2 * i + 1] << 8));
      out[i]     = (int16_t)(b[6 + 2 * i] | (b[7 + 2 * i] << 8));
    }
    return true;
  }
  if (imuType == IMU_MPU6050) {
    if (!i2cRead(imuAddr, 0x3B, b, 14)) return false;   // accel, temp, gyro (big endian)
    for (int i = 0; i < 3; i++) {
      out[i]     = (int16_t)((b[2 * i] << 8) | b[2 * i + 1]);
      out[3 + i] = (int16_t)((b[8 + 2 * i] << 8) | b[9 + 2 * i]);
    }
    return true;
  }
  return false;
}

static const char* imuName() {
  switch (imuType) {
    case IMU_LSM6DSO32: return "LSM6DSO32";
    case IMU_MPU6050:
      switch (imuWho) {
        case 0x70: return "MPU-6500";
        case 0x71: return "MPU-9250";
        case 0x73: return "MPU-9255";
        case 0x68: return "MPU-6050";
        default:   return "MPU-6xxx";
      }
    default:            return "none";
  }
}

// ------------------------------------------------------------------ settings
static void loadSettings() {
  prefs.begin("bmx", true);
  cfg.wheelCircMm  = prefs.getUShort("circ", cfg.wheelCircMm);
  cfg.wheelMagnets = prefs.getUChar("wmag", cfg.wheelMagnets);
  cfg.crankMagnets = prefs.getUChar("cmag", cfg.crankMagnets);
  cfg.chainring    = prefs.getUChar("ring", cfg.chainring);
  cfg.cog          = prefs.getUChar("cog", cfg.cog);
  cfg.forwardAxis  = prefs.getUChar("fwd", cfg.forwardAxis);
  cfg.rateHz       = prefs.getUShort("rate", cfg.rateHz);
  cfg.autoStopS    = prefs.getUChar("astop", cfg.autoStopS);
  prefs.end();
  if (cfg.rateHz < 100 || cfg.rateHz > 500) cfg.rateHz = 250;
  if (cfg.wheelMagnets < 1) cfg.wheelMagnets = 1;
  if (cfg.crankMagnets < 1) cfg.crankMagnets = 1;
}

static void saveSettings() {
  prefs.begin("bmx", false);
  prefs.putUShort("circ", cfg.wheelCircMm);
  prefs.putUChar("wmag", cfg.wheelMagnets);
  prefs.putUChar("cmag", cfg.crankMagnets);
  prefs.putUChar("ring", cfg.chainring);
  prefs.putUChar("cog", cfg.cog);
  prefs.putUChar("fwd", cfg.forwardAxis);
  prefs.putUShort("rate", cfg.rateHz);
  prefs.putUChar("astop", cfg.autoStopS);
  prefs.end();
}

static uint32_t nextRunId() {
  prefs.begin("bmx", false);
  uint32_t id = prefs.getUInt("nextId", 1);
  prefs.putUInt("nextId", id + 1);
  prefs.end();
  return id;
}

// ------------------------------------------------------------------ sampler
static void sampleTimerCb(void*) {
  if (samplerTask) xTaskNotifyGive(samplerTask);
}

static void startSampleTimer() {
  if (!sampleTimer) {
    esp_timer_create_args_t a = {};
    a.callback = &sampleTimerCb;
    a.name = "sample";
    esp_timer_create(&a, &sampleTimer);
  } else {
    esp_timer_stop(sampleTimer);
  }
  esp_timer_start_periodic(sampleTimer, 1000000ULL / cfg.rateHz);
}

static inline void pushRec(uint32_t t, RecType type, const int16_t* v) {
  Rec r;
  r.tw = (t & 0x3FFFFFFFUL) | ((uint32_t)type << 30);
  for (int i = 0; i < 6; i++) r.v[i] = v ? v[i] : 0;
  if (xStreamBufferSend(recBuf, &r, sizeof(r), 0) == sizeof(r)) {
    bytesQueued = bytesQueued + REC_SIZE;
  } else {
    overflowCount = overflowCount + 1;
  }
}

static void drainPulses(PulseRing& p, RecType type, bool record, uint32_t start) {
  uint32_t head = p.head;
  while (p.tail != head) {
    uint32_t t = p.t[p.tail & 63];
    p.tail++;
    if (!record) continue;
    int32_t rel = (int32_t)(t - start);
    if (rel < 0) continue;
    pushRec((uint32_t)rel, type, nullptr);
    if (type == REC_WHEEL) runWheelPulses = runWheelPulses + 1;
    else runCrankPulses = runCrankPulses + 1;
  }
}

static void samplerLoop(void*) {
  int16_t v[6];
  for (;;) {
    static uint32_t errRun = 0;
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    uint32_t now = micros();
    bool ok = imuType != IMU_NONE && imuRead(v);
    if (ok) {
      for (int i = 0; i < 6; i++) latest[i] = v[i];
    } else if (imuType != IMU_NONE) {
      imuErrors = imuErrors + 1;
      if (++errRun >= 25) { errRun = 0; vTaskDelay(pdMS_TO_TICKS(50)); }   // let other tasks run
    }
    if (ok) errRun = 0;

    if (gState != ST_RECORDING) {
      drainPulses(wheelP, REC_WHEEL, false, 0);
      drainPulses(crankP, REC_CRANK, false, 0);
      gMarkReq = false;
      continue;
    }

    uint32_t start = runStartUs;
    drainPulses(wheelP, REC_WHEEL, true, start);
    drainPulses(crankP, REC_CRANK, true, start);
    uint32_t rel = now - start;
    if (gMarkReq) { gMarkReq = false; pushRec(rel, REC_MARK, nullptr); }
    if (ok) pushRec(rel, REC_IMU, v);

    bool stop = gStopReq;
    if (bytesQueued + 64 * REC_SIZE >= SLOT_SIZE - HEADER_SIZE) stop = true;   // slot full
    if (cfg.autoStopS && runWheelPulses >= 10 && rel > 3000000UL &&
        (now - wheelP.lastUs) > (uint32_t)cfg.autoStopS * 1000000UL) stop = true;
    if (stop) {
      gStopReq = false;
      gState = ST_FINISHING;
    }
  }
}

// ------------------------------------------------------------------ flash slots
static uint32_t slotOffset(uint32_t s) { return s * SLOT_SIZE; }

static bool readHeader(uint32_t s, RunHeader& h) {
  if (esp_partition_read(runsPart, slotOffset(s), &h, sizeof(h)) != ESP_OK) return false;
  return h.magic == RUN_MAGIC && h.headerSize == HEADER_SIZE;
}

// Length of a run whose power died before it was closed: find first blank record.
static uint32_t scanDataBytes(uint32_t s) {
  uint32_t lo = 0, hi = (SLOT_SIZE - HEADER_SIZE) / REC_SIZE;
  uint8_t r[REC_SIZE];
  while (lo < hi) {
    uint32_t mid = (lo + hi) / 2;
    esp_partition_read(runsPart, slotOffset(s) + HEADER_SIZE + mid * REC_SIZE, r, REC_SIZE);
    bool blank = true;
    for (uint32_t i = 0; i < REC_SIZE; i++) if (r[i] != 0xFF) { blank = false; break; }
    if (blank) hi = mid; else lo = mid + 1;
  }
  return lo * REC_SIZE;
}

static uint32_t runBytes(uint32_t s, const RunHeader& h) {
  return h.dataBytes == 0xFFFFFFFFUL ? scanDataBytes(s) : h.dataBytes;
}

static int findSlotById(uint32_t id) {
  RunHeader h;
  for (uint32_t s = 0; s < numSlots; s++)
    if (readHeader(s, h) && h.runId == id) return (int)s;
  return -1;
}

static uint32_t chooseSlot() {
  RunHeader h;
  uint32_t oldest = 0, oldestId = 0xFFFFFFFFUL;
  for (uint32_t s = 0; s < numSlots; s++) {
    if (!readHeader(s, h)) return s;                 // free slot
    if (h.runId < oldestId) { oldestId = h.runId; oldest = s; }
  }
  return oldest;                                     // overwrite oldest run
}

// ------------------------------------------------------------------ writer task
static void writerLoop(void*) {
  static uint8_t page[4096];
  uint32_t fill = 0;
  for (;;) {
    uint8_t st = gState;
    if (st == ST_PREPARING) {
      curSlot = chooseSlot();
      esp_err_t e = esp_partition_erase_range(runsPart, slotOffset(curSlot), SLOT_SIZE);
      if (e != ESP_OK) {
        lastError = "flash erase failed";
        gState = ST_IDLE;
        continue;
      }
      memset(&curHdr, 0, sizeof(curHdr));
      curHdr.magic = RUN_MAGIC;
      curHdr.version = 1;
      curHdr.headerSize = HEADER_SIZE;
      curHdr.runId = nextRunId();
      curHdr.rateHz = cfg.rateHz;
      curHdr.imuType = imuType;
      curHdr.accLsbPerG = accLsbPerG;
      curHdr.gyrLsbPerDps = gyrLsbPerDps;
      curHdr.epoch = pendingEpoch;
      curHdr.wheelMagnets = cfg.wheelMagnets;
      curHdr.crankMagnets = cfg.crankMagnets;
      curHdr.chainring = cfg.chainring;
      curHdr.cog = cfg.cog;
      curHdr.wheelCircMm = cfg.wheelCircMm;
      curHdr.forwardAxis = cfg.forwardAxis;
      memcpy(curHdr.label, pendingLabel, sizeof(curHdr.label));
      curHdr.dataBytes = 0xFFFFFFFFUL;
      curHdr.reserved1 = 0xFFFFFFFFUL;
      esp_partition_write(runsPart, slotOffset(curSlot), &curHdr, sizeof(curHdr));

      xStreamBufferReset(recBuf);
      fill = 0;
      bytesQueued = 0;
      bytesWritten = 0;
      overflowCount = 0;
      runWheelPulses = 0;
      runCrankPulses = 0;
      gStopReq = false;
      lastError = "";
      runStartUs = micros();
      gState = ST_RECORDING;
      continue;
    }

    if (st == ST_RECORDING || st == ST_FINISHING) {
      size_t n = xStreamBufferReceive(recBuf, page + fill, sizeof(page) - fill, pdMS_TO_TICKS(50));
      fill += n;
      if (fill == sizeof(page)) {
        esp_partition_write(runsPart, slotOffset(curSlot) + HEADER_SIZE + bytesWritten, page, fill);
        bytesWritten = bytesWritten + fill;
        fill = 0;
      }
      if (st == ST_FINISHING && xStreamBufferIsEmpty(recBuf)) {
        if (fill) {
          esp_partition_write(runsPart, slotOffset(curSlot) + HEADER_SIZE + bytesWritten, page, fill);
          bytesWritten = bytesWritten + fill;
          fill = 0;
        }
        uint32_t total = bytesWritten;
        // dataBytes field was left at 0xFFFFFFFF, so it can be programmed without an erase
        esp_partition_write(runsPart, slotOffset(curSlot) + offsetof(RunHeader, dataBytes), &total, 4);
        gState = ST_IDLE;
      }
      continue;
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

// ------------------------------------------------------------------ helpers
static const char* stateName() {
  switch (gState) {
    case ST_PREPARING: return "preparing";
    case ST_RECORDING: return "recording";
    case ST_FINISHING: return "saving";
    default:           return "idle";
  }
}

static String jsonStr(const char* s, size_t maxLen) {
  String o = "\"";
  for (size_t i = 0; i < maxLen && s[i]; i++) {
    char c = s[i];
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if ((uint8_t)c < 0x20) o += ' ';
    else o += c;
  }
  o += "\"";
  return o;
}

static bool requestArm(const String& label, uint32_t epoch, String& err) {
  if (!runsPart) { err = "runs partition missing (partitions.csv not used)"; return false; }
  if (imuType == IMU_NONE) { err = "no motion sensor found"; return false; }
  if (gState != ST_IDLE) { err = "busy"; return false; }
  memset(pendingLabel, 0, sizeof(pendingLabel));
  size_t j = 0;
  for (size_t i = 0; i < label.length() && j < sizeof(pendingLabel) - 1; i++) {
    char c = label[i];
    if (c >= 0x20 && c != '"' && c != '\\') pendingLabel[j++] = c;
  }
  pendingEpoch = epoch;
  gState = ST_PREPARING;
  return true;
}

// ------------------------------------------------------------------ commands
// Each command takes its arguments through Args and returns {status code, JSON text}.
struct Args {
  virtual bool has(const char* n) const = 0;
  virtual String get(const char* n) const = 0;
  virtual ~Args() {}
  long getLong(const char* n, long def, long lo, long hi) const {
    if (!has(n)) return def;
    long v = get(n).toInt();
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    return v;
  }
};


static String apiStatus() {
  int16_t v[6];
  for (int i = 0; i < 6; i++) v[i] = latest[i];
  float wr = pulseRpm(wheelP, cfg.wheelMagnets);
  float cr = pulseRpm(crankP, cfg.crankMagnets);
  float kmh = wr * cfg.wheelCircMm / 1000.0f * 60.0f / 1000.0f;
  uint32_t used = 0;
  if (runsPart) {
    RunHeader h;
    for (uint32_t s = 0; s < numSlots; s++) if (readHeader(s, h)) used++;
  }
  uint32_t elapsed = (gState == ST_RECORDING) ? (micros() - runStartUs) / 1000 : 0;
  char buf[680];
  snprintf(buf, sizeof(buf),
    "{\"state\":\"%s\",\"imu\":\"%s\",\"imuErrors\":%lu,\"slots\":%lu,\"used\":%lu,"
    "\"run\":%lu,\"elapsedMs\":%lu,\"bytes\":%lu,\"cap\":%lu,\"overflow\":%lu,"
    "\"wheelPulses\":%lu,\"crankPulses\":%lu,\"wheelRpm\":%.1f,\"crankRpm\":%.1f,\"kmh\":%.1f,"
    "\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"gx\":%.1f,\"gy\":%.1f,\"gz\":%.1f,\"err\":%s}",
    stateName(), imuName(), (unsigned long)imuErrors, (unsigned long)numSlots, (unsigned long)used,
    (unsigned long)(gState != ST_IDLE ? curHdr.runId : 0), (unsigned long)elapsed,
    (unsigned long)bytesQueued, (unsigned long)(SLOT_SIZE - HEADER_SIZE), (unsigned long)overflowCount,
    (unsigned long)wheelP.count, (unsigned long)crankP.count, wr, cr, kmh,
    v[0] / accLsbPerG, v[1] / accLsbPerG, v[2] / accLsbPerG,
    v[3] / gyrLsbPerDps, v[4] / gyrLsbPerDps, v[5] / gyrLsbPerDps,
    jsonStr(lastError.c_str(), 80).c_str());
  return String(buf);
}

static String apiSettings() {
  char buf[256];
  snprintf(buf, sizeof(buf),
    "{\"wheelCircMm\":%u,\"wheelMagnets\":%u,\"crankMagnets\":%u,\"chainring\":%u,\"cog\":%u,"
    "\"forwardAxis\":%u,\"rateHz\":%u,\"autoStopS\":%u}",
    cfg.wheelCircMm, cfg.wheelMagnets, cfg.crankMagnets, cfg.chainring, cfg.cog,
    cfg.forwardAxis, cfg.rateHz, cfg.autoStopS);
  return String(buf);
}

static const char* BUSY_JSON = "{\"ok\":false,\"err\":\"busy\"}";

static int apiSettingsSet(const Args& a, String& out) {
  if (gState != ST_IDLE) { out = BUSY_JSON; return 409; }
  cfg.wheelCircMm  = a.getLong("wheelCircMm", cfg.wheelCircMm, 500, 3000);
  cfg.wheelMagnets = a.getLong("wheelMagnets", cfg.wheelMagnets, 1, 16);
  cfg.crankMagnets = a.getLong("crankMagnets", cfg.crankMagnets, 1, 4);
  cfg.chainring    = a.getLong("chainring", cfg.chainring, 20, 70);
  cfg.cog          = a.getLong("cog", cfg.cog, 9, 30);
  cfg.forwardAxis  = a.getLong("forwardAxis", cfg.forwardAxis, 0, 5);
  uint16_t oldRate = cfg.rateHz;
  cfg.rateHz       = a.getLong("rateHz", cfg.rateHz, 100, 500);
  cfg.autoStopS    = a.getLong("autoStopS", cfg.autoStopS, 0, 60);
  saveSettings();
  if (cfg.rateHz != oldRate) startSampleTimer();
  out = apiSettings();
  return 200;
}

static int apiArm(const Args& a, String& out) {
  if ((a.has("chainring") || a.has("cog")) && gState == ST_IDLE) {
    cfg.chainring = a.getLong("chainring", cfg.chainring, 20, 70);
    cfg.cog = a.getLong("cog", cfg.cog, 9, 30);
    saveSettings();
  }
  String err;
  uint32_t epoch = (uint32_t)strtoul(a.get("epoch").c_str(), nullptr, 10);
  if (requestArm(a.get("label"), epoch, err)) { out = "{\"ok\":true}"; return 200; }
  out = "{\"ok\":false,\"err\":" + jsonStr(err.c_str(), 80) + "}";
  return 409;
}

static String apiRuns() {
  String out = "[";
  if (runsPart) {
    RunHeader h;
    bool first = true;
    for (uint32_t s = 0; s < numSlots; s++) {
      if (!readHeader(s, h)) continue;
      if (gState != ST_IDLE && s == curSlot) continue;   // still being written
      char buf[200];
      snprintf(buf, sizeof(buf),
        "{\"id\":%lu,\"epoch\":%lu,\"bytes\":%lu,\"rateHz\":%u,\"chainring\":%u,\"cog\":%u,\"closed\":%s,\"label\":",
        (unsigned long)h.runId, (unsigned long)h.epoch, (unsigned long)runBytes(s, h), h.rateHz,
        h.chainring, h.cog, h.dataBytes == 0xFFFFFFFFUL ? "false" : "true");
      if (!first) out += ",";
      first = false;
      out += buf;
      out += jsonStr(h.label, sizeof(h.label));
      out += "}";
    }
  }
  out += "]";
  return out;
}

// Finds a finished run and returns its closed header and total file size (header + data).
static bool runForDownload(uint32_t id, uint32_t& base, RunHeader& h, uint32_t& total) {
  int s = findSlotById(id);
  if (s < 0 || (gState != ST_IDLE && (uint32_t)s == curSlot)) return false;
  readHeader(s, h);
  uint32_t data = runBytes(s, h);
  h.dataBytes = data;                     // send a closed header even if power died
  total = HEADER_SIZE + data;
  base = slotOffset(s);
  return true;
}

// Fills out[0..n) with bytes [index, index+n) of the run file.
static void readRunBytes(const RunHeader& h, uint32_t base, size_t index, uint8_t* out, size_t n) {
  size_t done = 0;
  if (index < HEADER_SIZE) {
    size_t hn = HEADER_SIZE - index;
    if (hn > n) hn = n;
    memcpy(out, ((const uint8_t*)&h) + index, hn);
    done = hn;
  }
  if (done < n) esp_partition_read(runsPart, base + index + done, out + done, n - done);
}

static int apiDelete(const Args& a, String& out) {
  if (gState != ST_IDLE) { out = BUSY_JSON; return 409; }
  int s = findSlotById(strtoul(a.get("id").c_str(), nullptr, 10));
  if (s < 0) { out = "{\"ok\":false,\"err\":\"not found\"}"; return 404; }
  esp_partition_erase_range(runsPart, slotOffset(s), 4096);   // wipes the header
  out = "{\"ok\":true}";
  return 200;
}

// ------------------------------------------------------------------ Bluetooth
static const char* BLE_SVC  = "6e7a0001-3b2c-4d1a-9f5e-8b6c4d2a1f00";
static const char* BLE_CMD  = "6e7a0002-3b2c-4d1a-9f5e-8b6c4d2a1f00";
static const char* BLE_RESP = "6e7a0003-3b2c-4d1a-9f5e-8b6c4d2a1f00";
static const char* BLE_STAT = "6e7a0004-3b2c-4d1a-9f5e-8b6c4d2a1f00";

static NimBLEServer* bleServer = nullptr;
static NimBLECharacteristic* chrResp = nullptr;
static NimBLECharacteristic* chrStat = nullptr;
static volatile uint16_t bleConn = BLE_HS_CONN_HANDLE_NONE;
static volatile uint16_t bleMtu = 23;
static QueueHandle_t bleCmdQ = nullptr;
struct BleCmd { uint16_t len; char data[256]; };

struct CmdArgs : Args {
  const bmxble::Command& c;
  explicit CmdArgs(const bmxble::Command& cmd) : c(cmd) {}
  bool has(const char* n) const override { return c.has(n); }
  String get(const char* n) const override { return String(c.get(n).c_str()); }
};

class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    bleConn = info.getConnHandle();
    bleMtu = info.getMTU();
    s->updateConnParams(info.getConnHandle(), 6, 12, 0, 300);   // 7.5-15 ms interval for faster transfers
    Serial.println("Bluetooth: phone connected");
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int reason) override {
    bleConn = BLE_HS_CONN_HANDLE_NONE;
    bleMtu = 23;
    Serial.printf("Bluetooth: phone disconnected (reason %d)\n", reason);
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo&) override { bleMtu = mtu; }
};

class CmdCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo&) override {
    NimBLEAttValue v = c->getValue();
    BleCmd cmd;
    cmd.len = v.length() < sizeof(cmd.data) ? v.length() : sizeof(cmd.data);
    memcpy(cmd.data, v.data(), cmd.len);
    xQueueSend(bleCmdQ, &cmd, 0);
  }
};

// Sends one framed message, retrying while the Bluetooth buffers are full.
static bool bleSend(NimBLECharacteristic* chr, uint8_t type, const uint8_t* data, size_t len) {
  return bmxble::sendFramed(type, data, len, bleMtu, [chr](const uint8_t* f, size_t n) {
    for (int tries = 0; tries < 3000; tries++) {
      if (bleConn == BLE_HS_CONN_HANDLE_NONE) return false;
      if (chr->notify(f, n, bleConn)) return true;
      vTaskDelay(1);
    }
    return false;
  });
}
static bool bleSendJson(NimBLECharacteristic* chr, const String& s) {
  return bleSend(chr, bmxble::FRAME_JSON, (const uint8_t*)s.c_str(), s.length());
}

static void bleHandle(const BleCmd& raw) {
  bmxble::Command c = bmxble::parseCommand(raw.data, raw.len);
  CmdArgs a(c);
  String out;
  Serial.printf("Bluetooth: command %s\n", c.name.c_str());
  if (c.name == "status") out = apiStatus();
  else if (c.name == "settings") out = apiSettings();
  else if (c.name == "set") apiSettingsSet(a, out);
  else if (c.name == "arm") apiArm(a, out);
  else if (c.name == "stop") { if (gState == ST_RECORDING) gStopReq = true; out = "{\"ok\":true}"; }
  else if (c.name == "mark") { if (gState == ST_RECORDING) gMarkReq = true; out = "{\"ok\":true}"; }
  else if (c.name == "runs") out = apiRuns();
  else if (c.name == "del") apiDelete(a, out);
  else if (c.name == "get") {
    uint32_t base, total;
    RunHeader h;
    if (!runForDownload(strtoul(a.get("id").c_str(), nullptr, 10), base, h, total)) {
      bleSendJson(chrResp, "{\"ok\":false,\"err\":\"not found\"}");
      return;
    }
    // Stream the file as binary frames, 4 KB of flash at a time.
    static uint8_t chunk[4096];
    size_t pay = bmxble::framePayload(bleMtu);
    uint8_t frame[512];
    uint32_t t0 = millis();
    for (size_t off = 0; off < total; ) {
      size_t n = total - off;
      if (n > sizeof(chunk)) n = sizeof(chunk);
      readRunBytes(h, base, off, chunk, n);
      for (size_t i = 0; i < n; i += pay) {
        size_t k = n - i < pay ? n - i : pay;
        bool last = off + i + k >= total;
        frame[0] = bmxble::FRAME_BIN | (last ? bmxble::FRAME_LAST : 0);
        memcpy(frame + 1, chunk + i, k);
        bool sent = false;
        for (int tries = 0; tries < 3000 && !sent; tries++) {
          if (bleConn == BLE_HS_CONN_HANDLE_NONE) return;
          sent = chrResp->notify(frame, k + 1, bleConn);
          if (!sent) vTaskDelay(1);
        }
        if (!sent) return;
      }
      off += n;
    }
    Serial.printf("Bluetooth: sent run, %lu bytes in %lu ms\n", (unsigned long)total, (unsigned long)(millis() - t0));
    return;
  }
  else out = "{\"ok\":false,\"err\":\"unknown command\"}";
  bleSendJson(chrResp, out);
}

static void bleLoop(void*) {
  BleCmd cmd;
  uint32_t lastStat = 0;
  for (;;) {
    if (xQueueReceive(bleCmdQ, &cmd, pdMS_TO_TICKS(50)) == pdTRUE) bleHandle(cmd);
    if (bleConn != BLE_HS_CONN_HANDLE_NONE && millis() - lastStat >= 500) {
      lastStat = millis();
      bleSendJson(chrStat, apiStatus());
    }
  }
}

static void bleStart() {
  NimBLEDevice::init("BMX-Logger");
  NimBLEDevice::setMTU(517);
  bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(new ServerCb());
  NimBLEService* svc = bleServer->createService(BLE_SVC);
  NimBLECharacteristic* cmd = svc->createCharacteristic(BLE_CMD, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR, 256);
  cmd->setCallbacks(new CmdCb());
  chrResp = svc->createCharacteristic(BLE_RESP, NIMBLE_PROPERTY::NOTIFY);
  chrStat = svc->createCharacteristic(BLE_STAT, NIMBLE_PROPERTY::NOTIFY);
  svc->start();
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->setName("BMX-Logger");
  adv->addServiceUUID(BLE_SVC);
  adv->enableScanResponse(true);
  adv->start();
  bleCmdQ = xQueueCreate(8, sizeof(BleCmd));
  xTaskCreatePinnedToCore(bleLoop, "ble", 8192, nullptr, 3, nullptr, 0);
  Serial.println("Bluetooth: advertising as BMX-Logger");
}

// ------------------------------------------------------------------ setup / loop
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nBMX logger starting (build: bluetooth only)");

  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_WHEEL, INPUT_PULLUP);
  pinMode(PIN_CRANK, INPUT_PULLUP);

  loadSettings();

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  Wire.setTimeOut(5);
  if (imuInit()) Serial.printf("IMU: %s at 0x%02X\n", imuName(), imuAddr);
  else Serial.println("IMU: none found - check SDA=21 SCL=22 and 3V3 power");

  runsPart = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, (esp_partition_subtype_t)0x40, "runs");
  if (runsPart) {
    numSlots = runsPart->size / SLOT_SIZE;
    Serial.printf("Runs partition: %lu KB, %lu slots\n", (unsigned long)(runsPart->size / 1024), (unsigned long)numSlots);
  } else {
    lastError = "runs partition missing (partitions.csv not used)";
    Serial.println(lastError);
  }

  recBuf = xStreamBufferCreate(32 * 1024, 1);

  wheelP.lockoutUs = WHEEL_LOCKOUT_US;
  crankP.lockoutUs = CRANK_LOCKOUT_US;
  attachInterrupt(digitalPinToInterrupt(PIN_WHEEL), wheelIsr, FALLING);
  attachInterrupt(digitalPinToInterrupt(PIN_CRANK), crankIsr, FALLING);

  xTaskCreatePinnedToCore(samplerLoop, "sampler", 4096, nullptr, configMAX_PRIORITIES - 2, &samplerTask, 1);
  xTaskCreatePinnedToCore(writerLoop, "writer", 4096, nullptr, 5, nullptr, 0);
  startSampleTimer();

  bleStart();
}

void loop() {
  static uint32_t lastBeat = 0;
  if (millis() - lastBeat > 5000) {
    lastBeat = millis();
    Serial.printf("alive: %lu s, bluetooth: %s, sensor: %s, sensor errors: %lu\n",
      (unsigned long)(millis() / 1000), bleConn != BLE_HS_CONN_HANDLE_NONE ? "connected" : "waiting",
      imuName(), (unsigned long)imuErrors);
  }

  // button: press to arm, press again to stop (50 ms debounce)
  static bool lastBtn = true;
  static uint32_t btnChange = 0;
  bool btn = digitalRead(PIN_BUTTON);
  if (btn != lastBtn && millis() - btnChange > 50) {
    btnChange = millis();
    lastBtn = btn;
    if (!btn) {
      if (gState == ST_IDLE) { String e; requestArm("button", 0, e); }
      else if (gState == ST_RECORDING) gStopReq = true;
    }
  }

  // LED: recording = solid, preparing/saving = fast blink, Bluetooth connected = slow pulse,
  // idle = short blip every 2 s, no sensor = double blink
  uint32_t ms = millis();
  bool on;
  switch (gState) {
    case ST_RECORDING: on = true; break;
    case ST_PREPARING:
    case ST_FINISHING: on = (ms / 100) % 2; break;
    default:
      if (imuType == IMU_NONE) { uint32_t p = ms % 1000; on = p < 80 || (p > 200 && p < 280); }
      else if (bleConn != BLE_HS_CONN_HANDLE_NONE) on = (ms % 2000) < 1000;
      else on = (ms % 2000) < 40;
  }
  digitalWrite(PIN_LED, on);
  delay(2);
}
