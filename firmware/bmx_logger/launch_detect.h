// BMX logger - gate-start detector (no Arduino dependencies, unit-tested on a PC).
//
// While armed, the logger watches wheel magnet pulses. It triggers when the wheel reaches the
// launch speed within a few seconds of starting to roll after standing still. Rolling slowly to
// the gate never reaches the launch speed, and riding around without stopping does not count as a
// launch, so the logger stays armed until the real start.
#pragma once
#include <stdint.h>

namespace bmxtrig {

struct Config {
  float metersPerPulse = 0.7575f;   // wheel circumference / magnets
  float launchKmh = 12.0f;          // trigger speed
  uint32_t stillUs = 2000000;       // bike must stand still this long first (0 = speed only)
  uint32_t windowUs = 4000000;      // ...and reach launch speed within this long of starting to roll
};

class LaunchDetector {
 public:
  // Call when the logger is armed. Time spent armed with the wheel still counts as standing still.
  void reset(uint32_t armUs) { lastUs = armUs; startValid = false; }

  // Feed every wheel pulse time (microseconds, increasing). Returns true on the pulse that
  // completes a launch.
  bool onWheelPulse(uint32_t t, const Config& c) {
    uint32_t dt = t - lastUs;
    lastUs = t;
    if (c.stillUs == 0) return speedKmh(dt, c) >= c.launchKmh;
    if (dt >= c.stillUs) {                 // the wheel had been still: this pulse starts a roll
      startUs = t; startValid = true;
      return false;
    }
    if (!startValid) return false;
    if (t - startUs > c.windowUs) { startValid = false; return false; }   // too slow to be a launch
    return speedKmh(dt, c) >= c.launchKmh;
  }

  static float speedKmh(uint32_t dtUs, const Config& c) {
    return dtUs ? c.metersPerPulse / (dtUs / 1e6f) * 3.6f : 0.0f;
  }

 private:
  uint32_t lastUs = 0, startUs = 0;
  bool startValid = false;
};

}  // namespace bmxtrig
