#!/usr/bin/env python3
"""Hall sensor clip for a BMX chainstay: a snap-on C-clip with a channel that holds a
heat-shrunk A3144 sensor, its flat face behind a thin wall that faces the wheel magnet.

    python3 hardware/make_sensor_clip.py --tube 19        # writes hardware/sensor_clip_19mm.stl
    python3 hardware/make_sensor_clip.py --tube 19 --json clip.json   # also the viewer mesh

Measure the chainstay where the clip goes (calipers). Oval stays: use the smaller width.
Coordinates in mm. The tube runs along Z; the sensor faces +X (toward the wheel).
The STL is several overlapping closed solids; PrusaSlicer, Cura and Bambu Studio merge them.
"""
import argparse, json, math, struct
from pathlib import Path

# ---------------------------------------------------------------- parameters
P = dict(
    width=14.0,          # clip length along the tube
    wall=2.8,            # C-ring thickness
    opening_deg=100.0,   # gap in the C (smaller = tighter snap; chord must be < tube diameter)
    grip=0.2,            # ring bore this much smaller than the tube, for a snug snap
    ch_w=6.6,            # sensor channel width  (heat-shrunk TO-92 is about 5.2 x 2.6 mm)
    ch_t=3.6,            # sensor channel depth
    face=1.2,            # plastic between the sensor face and the magnet side
    side=1.7,            # channel side walls
    stop=1.2,            # end stop thickness (front end of the channel)
)

# ---------------------------------------------------------------- tiny mesh helpers
def quad(t, a, b, c, d):          # a-b-c-d counter-clockwise seen from outside
    t += [(a, b, c), (a, c, d)]

def box(x0, x1, y0, y1, z0, z1):
    v = [(x, y, z) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
    p = lambda i: v[i]
    t = []
    quad(t, p(0), p(2), p(3), p(1))   # z0 (bottom, normal -z)
    quad(t, p(4), p(5), p(7), p(6))   # z1
    quad(t, p(0), p(1), p(5), p(4))   # y0
    quad(t, p(2), p(6), p(7), p(3))   # y1
    quad(t, p(0), p(4), p(6), p(2))   # x0
    quad(t, p(1), p(3), p(7), p(5))   # x1
    return t

def sector(r0, r1, a0, a1, z0, z1, n=48):
    """Closed annular sector, angles in degrees, extruded along Z."""
    t = []
    pts = [math.radians(a0 + (a1 - a0) * i / n) for i in range(n + 1)]
    P_ = lambda r, a, z: (r * math.cos(a), r * math.sin(a), z)
    for i in range(n):
        a, b = pts[i], pts[i + 1]
        quad(t, P_(r1, a, z0), P_(r1, b, z0), P_(r1, b, z1), P_(r1, a, z1))   # outer
        quad(t, P_(r0, a, z0), P_(r0, a, z1), P_(r0, b, z1), P_(r0, b, z0))   # inner
        quad(t, P_(r0, a, z1), P_(r1, a, z1), P_(r1, b, z1), P_(r0, b, z1))   # top
        quad(t, P_(r0, a, z0), P_(r0, b, z0), P_(r1, b, z0), P_(r1, a, z0))   # bottom
    a, b = pts[0], pts[-1]
    quad(t, P_(r0, a, z0), P_(r1, a, z0), P_(r1, a, z1), P_(r0, a, z1))       # end at a0
    quad(t, P_(r0, b, z0), P_(r0, b, z1), P_(r1, b, z1), P_(r1, b, z0))       # end at a1
    return t

def cylinder(p0, p1, r, n=24, caps=True, segs=1):
    """Closed cylinder from p0 to p1, split into `segs` sections along its length."""
    ax = [p1[i] - p0[i] for i in range(3)]
    L = math.sqrt(sum(c * c for c in ax)); ax = [c / L for c in ax]
    ref = (0, 0, 1) if abs(ax[2]) < 0.9 else (1, 0, 0)
    u = [ax[1] * ref[2] - ax[2] * ref[1], ax[2] * ref[0] - ax[0] * ref[2], ax[0] * ref[1] - ax[1] * ref[0]]
    ul = math.sqrt(sum(c * c for c in u)); u = [c / ul for c in u]
    w = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]]
    ring = lambda c, k: tuple(c[i] + r * (math.cos(k) * u[i] + math.sin(k) * w[i]) for i in range(3))
    t = []
    at = lambda f: tuple(p0[i] + (p1[i] - p0[i]) * f for i in range(3))
    for i in range(n):
        k0, k1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        for j in range(segs):
            a, b = at(j / segs), at((j + 1) / segs)
            quad(t, ring(a, k0), ring(a, k1), ring(b, k1), ring(b, k0))
        if caps:
            t.append((tuple(p0), ring(p0, k1), ring(p0, k0)))
            t.append((tuple(p1), ring(p1, k0), ring(p1, k1)))
    return t

# ---------------------------------------------------------------- the clip
def clip(tube):
    r0 = tube / 2 - P['grip'] / 2
    r1 = r0 + P['wall']
    half = P['opening_deg'] / 2
    a0, a1 = -90 + half, 270 - half                  # C opens toward -Y (underneath)
    z0, z1 = -P['width'] / 2, P['width'] / 2
    parts = []
    parts += sector(r0, r1, a0, a1, z0, z1)
    # rounded snap tips: easier to push on, less likely to crack
    rm = (r0 + r1) / 2
    for a in (a0, a1):
        c = (rm * math.cos(math.radians(a)), rm * math.sin(math.radians(a)))
        parts += cylinder((c[0], c[1], z0), (c[0], c[1], z1), P['wall'] / 2 + 0.25, n=20)
    # sensor housing on the +X side
    y_out = P['ch_w'] / 2 + P['side']
    x_in = r1 - 1.6                                   # sinks into the ring for a solid bond
    cx0 = r1 + 0.6                                    # channel starts just outside the ring
    cx1 = cx0 + P['ch_t']
    x_out = cx1 + P['face']
    cy = P['ch_w'] / 2
    parts += box(x_in, cx0, -y_out, y_out, z0, z1)              # inner wall (against the ring)
    parts += box(cx1, x_out, -y_out, y_out, z0, z1)             # sensing wall, faces the magnet
    parts += box(cx0, cx1, cy, y_out, z0, z1)                   # channel side
    parts += box(cx0, cx1, -y_out, -cy, z0, z1)                 # channel side
    parts += box(cx0, cx1, -cy, cy, z1 - P['stop'], z1)         # end stop at the front
    dims = dict(tube=tube, bore=round(2 * r0, 2), outer=round(2 * r1, 2),
                gap_chord=round(2 * r0 * math.sin(math.radians(half)), 2),
                channel=(P['ch_w'], P['ch_t']), face=P['face'], width=P['width'],
                face_x=round(x_out, 2), channel_x=(round(cx0, 2), round(cx1, 2)))
    return parts, dims

# ---------------------------------------------------------------- scene for the viewer
def scene(tube, dims):
    s = {}
    s['tube'] = cylinder((0, 0, -55), (0, 0, 9), tube / 2, n=40, segs=16)   # cut just past the clip
    # heat-shrunk sensor: body in the channel, leads + shrink tail out the back
    cx0, cx1 = dims['channel_x']
    sx0, sx1 = cx0 + 0.4, cx1 - 0.4
    zf = P['width'] / 2 - P['stop']
    s['sensor'] = box(sx0, sx1, -2.5, 2.5, zf - 4.2, zf - 0.1)              # the A3144 itself
    s['shrink'] = box(sx0 - 0.15, sx1 + 0.15, -2.75, 2.75, zf - 13, zf - 3.6)  # heat shrink over the leads
    xc = (sx0 + sx1) / 2
    cable = [(xc, 0, zf - 13), (xc, 0, -16), (xc - 1.5, 0, -24), (tube / 2 + 1.6, 0, -30), (tube / 2 + 1.6, 0, -40), (tube / 2 + 1.6, 0, -54)]
    t = []
    for a, b in zip(cable, cable[1:]):
        t += cylinder(a, b, 1.5, n=12)
    s['cable'] = t
    # zip-tie holding the cable to the tube
    s['tie'] = sector(tube / 2, tube / 2 + 0.9, -80, 260, -44, -40.6, n=36) + box(-2, 2, tube / 2 - 0.4, tube / 2 + 3.6, -44.4, -40.2)
    # magnet on a spoke, gap 4 mm from the sensing wall
    gap = 4.0
    mx = dims['face_x'] + gap
    s['magnet'] = cylinder((mx, 0, 0), (mx + 3, 0, 0), 4.0, n=28)
    s['spoke'] = cylinder((mx + 3.6, -38, 0), (mx + 3.6, 38, 0), 1.0, n=10, segs=12)
    return s

# ---------------------------------------------------------------- output
def write_stl(path, tris):
    with open(path, 'wb') as f:
        f.write(b'BMX logger hall sensor clip'.ljust(80, b' '))
        f.write(struct.pack('<I', len(tris)))
        for a, b, c in tris:
            u = [b[i] - a[i] for i in range(3)]; v = [c[i] - a[i] for i in range(3)]
            n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
            l = math.sqrt(sum(x * x for x in n)) or 1
            f.write(struct.pack('<12fH', *(x / l for x in n), *a, *b, *c, 0))

def pack(tris):
    """Flat list of rounded coordinates for the viewer: [x,y,z, x,y,z, x,y,z, ...] per triangle."""
    return [round(c, 2) for tri in tris for p in tri for c in p]

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--tube', type=float, default=19.0, help='chainstay diameter in mm')
    ap.add_argument('--out', help='STL path (default hardware/sensor_clip_<tube>mm.stl)')
    ap.add_argument('--json', help='also write the viewer scene here')
    a = ap.parse_args()
    tris, dims = clip(a.tube)
    out = Path(a.out or Path(__file__).parent / f"sensor_clip_{a.tube:g}mm.stl")
    write_stl(out, tris)
    print(f"{out}: {len(tris)} triangles, {dims}")
    if a.json:
        sc = scene(a.tube, dims)
        sc['clip'] = tris
        Path(a.json).write_text(json.dumps({'dims': dims, 'parts': {k: pack(v) for k, v in sc.items()}}, separators=(',', ':')))
        print(f"{a.json}: {sum(len(v) for v in sc.values())} triangles")
