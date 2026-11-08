// g++ -std=c++17 -I firmware/bmx_logger tools/test_launch_detect.cpp -o /tmp/t && /tmp/t
// Feeds simulated wheel pulses through the gate-start detector.
#include "launch_detect.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <algorithm>
#include <vector>
using namespace bmxtrig;

// Wheel pulses for a speed profile v(t) [m/s], sampled at 1 ms.
static std::vector<uint32_t> pulses(double t0, double t1, double (*v)(double), double mpp, double& dist) {
  std::vector<uint32_t> out;
  double next = (std::floor(dist / mpp) + 1) * mpp;
  for (double t = t0; t < t1; t += 0.001) {
    dist += v(t) * 0.001;
    while (dist >= next) { out.push_back((uint32_t)(t * 1e6)); next += mpp; }
  }
  return out;
}

static int firstTrigger(const std::vector<uint32_t>& ps, const Config& c, uint32_t armUs = 0) {
  LaunchDetector d; d.reset(armUs);
  for (size_t i = 0; i < ps.size(); i++) if (d.onWheelPulse(ps[i], c)) return (int)i;
  return -1;
}

// A race day: armed in the pits, walk to the gate (1.2 m/s with stops), roll onto the gate,
// stand 6 s, gate drops (reach 30 km/h in about 2 s).
static double walk(double t) { return (t < 20 || (t > 25 && t < 40)) ? 1.2 : 0.0; }
static double roll(double t) { return (t > 45 && t < 47) ? 2.0 : 0.0; }
static double gate(double t) { double s = t - 53; return s < 0 ? 0 : std::min(8.3, 4.5 * s); }
static double warm(double) { return 6.0; }                       // warm-up lap without stopping
static double ease(double t) { return t < 60 ? 0.0 : std::min(5.0, 0.4 * (t - 60)); }   // gentle roll-away
static double kick(double t) { return t < 60 ? 0.0 : std::min(5.0, 3.0 * (t - 60)); }   // hard push-off

int main() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  Config c; c.metersPerPulse = 1.515 / 2;                             // 20" wheel, 2 magnets
  double dist = 0;
  std::vector<uint32_t> ps;
  for (auto part : {pulses(0, 45, walk, c.metersPerPulse, dist), pulses(45, 53, roll, c.metersPerPulse, dist),
                    pulses(53, 60, gate, c.metersPerPulse, dist)})
    ps.insert(ps.end(), part.begin(), part.end());
  int i = firstTrigger(ps, c);
  assert(i >= 0);
  double tt = ps[i] / 1e6;
  printf("race day: %zu pulses before the gate, triggered at %.2f s (gate dropped at 53.00 s)\n",
         (size_t)std::count_if(ps.begin(), ps.end(), [](uint32_t p) { return p < 53e6; }), tt);
  assert(tt > 53.0 && tt < 54.2);                                     // within about a second of the drop

  // continuous riding never triggers when a stop is required
  dist = 0;
  auto w = pulses(0, 30, warm, c.metersPerPulse, dist);
  assert(firstTrigger(w, c) < 0);
  printf("warm-up lap without stopping: no trigger\n");

  // ...but does in speed-only mode
  Config s = c; s.stillUs = 0;
  assert(firstTrigger(w, s) >= 0);
  printf("speed-only mode: triggers on the warm-up lap, as configured\n");

  // rolling away gently (12 km/h only after 8 s) is not a launch; a hard push-off is
  dist = 0;
  auto e = pulses(0, 80, ease, c.metersPerPulse, dist);
  assert(firstTrigger(e, c) < 0);
  dist = 0;
  auto k = pulses(0, 70, kick, c.metersPerPulse, dist);
  assert(firstTrigger(k, c) >= 0);
  printf("gentle roll-away: no trigger; hard push-off: trigger\n");
  puts("launch detector tests passed");
}
