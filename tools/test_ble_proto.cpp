// g++ -std=c++17 -I firmware/bmx_logger tools/test_ble_proto.cpp -o /tmp/t && /tmp/t
#include "ble_proto.h"
#include <cassert>
#include <cstdio>
using namespace bmxble;

int main() {
  auto c = parseCommand("arm?label=44%2F16%20gate+1&epoch=1793725000&chainring=44&cog=16\n", 62);
  assert(c.name == "arm");
  assert(c.get("label") == "44/16 gate 1");
  assert(c.get("epoch") == "1793725000");
  assert(c.has("cog") && !c.has("missing"));
  auto d = parseCommand("runs", 4);
  assert(d.name == "runs" && d.args.empty());
  auto e = parseCommand("set?wheelCircMm=1515&&wheelMagnets=2&flag", 41);
  assert(e.get("wheelMagnets") == "2" && e.has("flag"));

  // framing round trip at several MTUs, including empty and exact-multiple payloads
  for (uint16_t mtu : {23, 185, 247, 517}) {
    for (size_t len : {(size_t)0, (size_t)1, framePayload(mtu), framePayload(mtu) * 3, (size_t)70000}) {
      std::vector<uint8_t> src(len);
      for (size_t i = 0; i < len; i++) src[i] = (uint8_t)(i * 31 + 7);
      std::vector<uint8_t> got;
      int frames = 0, lastSeen = 0;
      bool ok = sendFramed(FRAME_BIN, src.data(), src.size(), mtu, [&](const uint8_t* f, size_t n) {
        assert(n >= 1 && n <= (size_t)mtu - 3);
        assert((f[0] & 0x7f) == FRAME_BIN);
        assert(!lastSeen);
        if (f[0] & FRAME_LAST) lastSeen = 1;
        got.insert(got.end(), f + 1, f + n);
        frames++;
        return true;
      });
      assert(ok && lastSeen && got == src);
      printf("mtu %3u len %6zu -> %5d frames ok\n", mtu, len, frames);
    }
  }
  puts("ble_proto tests passed");
}
