// BMX logger - Bluetooth protocol helpers (no Arduino dependencies, so they can be unit-tested on a PC).
//
// Phone -> logger: UTF-8 text written to the CMD characteristic, like a URL path + query:
//     status | settings | set?k=v&... | arm?label=..&epoch=..&chainring=..&cog=.. | stop | mark
//     runs | get?id=N | del?id=N | wifi?on=0|1
// Logger -> phone: notifications on RESP (one message per command, in order) and STAT
// (a status message every 0.5 s). Each message is split into frames:
//     byte 0 = type (1 = JSON text, 2 = binary run file), with bit 7 set on the last frame
//     bytes 1.. = payload (up to MTU - 4 bytes)
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <string>
#include <vector>
#include <utility>

namespace bmxble {

static const uint8_t FRAME_JSON = 1;
static const uint8_t FRAME_BIN  = 2;
static const uint8_t FRAME_LAST = 0x80;

inline int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

inline std::string urlDecode(const std::string& s) {
  std::string o;
  o.reserve(s.size());
  for (size_t i = 0; i < s.size(); i++) {
    char c = s[i];
    if (c == '+') o += ' ';
    else if (c == '%' && i + 2 < s.size() && hexVal(s[i + 1]) >= 0 && hexVal(s[i + 2]) >= 0) {
      o += (char)(hexVal(s[i + 1]) * 16 + hexVal(s[i + 2]));
      i += 2;
    } else o += c;
  }
  return o;
}

struct Command {
  std::string name;
  std::vector<std::pair<std::string, std::string>> args;
  bool has(const char* k) const {
    for (auto& a : args) if (a.first == k) return true;
    return false;
  }
  std::string get(const char* k) const {
    for (auto& a : args) if (a.first == k) return a.second;
    return std::string();
  }
};

inline Command parseCommand(const char* data, size_t len) {
  Command c;
  std::string s(data, len);
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) s.pop_back();
  size_t q = s.find('?');
  c.name = s.substr(0, q);
  if (q == std::string::npos) return c;
  std::string rest = s.substr(q + 1);
  size_t pos = 0;
  while (pos <= rest.size()) {
    size_t amp = rest.find('&', pos);
    if (amp == std::string::npos) amp = rest.size();
    std::string part = rest.substr(pos, amp - pos);
    if (!part.empty()) {
      size_t eq = part.find('=');
      if (eq == std::string::npos) c.args.push_back({urlDecode(part), ""});
      else c.args.push_back({urlDecode(part.substr(0, eq)), urlDecode(part.substr(eq + 1))});
    }
    pos = amp + 1;
  }
  return c;
}

// Payload bytes per frame for a given ATT MTU (3 bytes ATT header + 1 byte frame header).
inline size_t framePayload(uint16_t mtu) {
  if (mtu < 23) mtu = 23;
  size_t n = (size_t)mtu - 4;
  if (n > 508) n = 508;
  return n;
}

// Splits `len` bytes into frames and hands each to send(frame, frameLen) in order.
// Returns false if send() fails (for example the phone disconnected).
template <typename SendFn>
bool sendFramed(uint8_t type, const uint8_t* data, size_t len, uint16_t mtu, SendFn send) {
  size_t pay = framePayload(mtu);
  uint8_t buf[512];
  size_t off = 0;
  do {
    size_t n = len - off;
    if (n > pay) n = pay;
    bool last = off + n >= len;
    buf[0] = type | (last ? FRAME_LAST : 0);
    if (n) memcpy(buf + 1, data + off, n);
    if (!send(buf, n + 1)) return false;
    off += n;
  } while (off < len);
  return true;
}

}  // namespace bmxble
