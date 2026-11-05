#!/usr/bin/env python3
"""Make a fake run file in the logger's format, for testing the app without hardware.
python3 tools/simulate_run.py out.bin --ring 44 --cog 16 --id 1
"""
import argparse, math, random, struct

ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--ring", type=int, default=44)
ap.add_argument("--cog", type=int, default=16)
ap.add_argument("--id", type=int, default=1)
ap.add_argument("--label", default="sim")
ap.add_argument("--rate", type=int, default=250)
ap.add_argument("--wm", type=int, default=2)
ap.add_argument("--cm", type=int, default=1)
ap.add_argument("--unclosed", action="store_true")
a = ap.parse_args()
random.seed(a.id)

circ = 1.515
ratio = a.ring / a.cog
acc_lsb, gyr_lsb = 2048.0, 16.4
dt = 1.0 / a.rate

# rider model: torque-limited at low cadence, cadence-limited at high speed
max_cad = 150.0                     # rpm the rider can spin
still = 1.5                         # seconds still before gate drop
coast = [(4.0, 5.0), (7.0, 8.2)]    # coasting windows after launch (pumping obstacles)
v = 0.0; dist = 0.0; crank_angle = 0.0
t = 0.0; T = still + 12.0
recs = []
wheel_next = circ / a.wm
crank_next = 1.0 / a.cm
pitch = 0.0

def rec(tt, typ, vals=(0, 0, 0, 0, 0, 0)):
    tw = (int(tt * 1e6) & 0x3FFFFFFF) | (typ << 30)
    recs.append(struct.pack("<I6h", tw, *[max(-32768, min(32767, int(x))) for x in vals]))

while t < T:
    tl = t - still
    pedaling = tl >= 0 and not any(s <= tl < e for s, e in coast) and tl < 10.0
    if tl >= 0:
        cad = v / circ * 60 / ratio
        if pedaling:
            force = 9.0 / ratio * max(0.0, 1 - cad / max_cad) * 1.6
        else:
            force = 0.0
        acc = force - 0.02 * v * v - 0.15
        if tl > 10.0:
            acc = -1.5
        v = max(0.0, v + acc * dt)
        dist += v * dt
        if pedaling:
            crank_angle += v / circ / ratio * dt
    while dist >= wheel_next:
        rec(t, 1); wheel_next += circ / a.wm
    while crank_angle >= crank_next:
        rec(t, 2); crank_next += 1.0 / a.cm
    # pitch: bumps during coast windows (jumps)
    target = 0.0
    for s, e in coast:
        if s <= tl < e:
            target = 20 * math.sin((tl - s) / (e - s) * 2 * math.pi)
    prate = (target - pitch) / dt * 0.05
    pitch += prate * dt
    p = math.radians(pitch)
    lin = 0 if tl < 0 else (acc if tl >= 0 else 0) / 9.81
    ax = (math.sin(p) + lin) * acc_lsb + random.gauss(0, 15)
    az = math.cos(p) * acc_lsb + random.gauss(0, 15)
    land = 0.0
    for s, e in coast:
        if abs(tl - e) < 0.02:
            land = 3.5
    az += land * acc_lsb
    gy = -prate * gyr_lsb + random.gauss(0, 5)
    rec(t, 0, (ax, random.gauss(0, 15), az, random.gauss(0, 5), gy, random.gauss(0, 5)))
    t += dt

data = b"".join(recs)
label = a.label.encode()[:19].ljust(20, b"\0")
hdr = struct.pack("<IHHIHBBffIBBBBHBB20sII",
                  0x4C584D42, 1, 64, a.id, a.rate, 1, 0, acc_lsb, gyr_lsb, 1793725000 + a.id * 600,
                  a.wm, a.cm, a.ring, a.cog, int(circ * 1000), 0, 0, label,
                  0xFFFFFFFF if a.unclosed else len(data), 0xFFFFFFFF)
assert len(hdr) == 64
with open(a.out, "wb") as f:
    f.write(hdr + data + (b"\xff" * 4096 if a.unclosed else b""))
print(f"{a.out}: {len(recs)} records, final speed {v:.1f} m/s, dist {dist:.1f} m")
