/* Simulated BMX lap on a track with obstacles, producing logger data (motion sensor, wheel and crank pulses)
   plus the truth, for testing the analysis and for the demo. Works in node (require) and the browser
   (window.BmxTrackSim).
   Physics along the track profile h(x): gravity on slopes, normal force from curvature, pedalling with a
   gear-limited force curve, pumping on backsides (rider pushes down: more normal force and some speed),
   airtime off jump lips (free fall, the sensor reads ~0 g), landing spikes, braking after the finish.
   Sensor frame: +X forward along the frame, +Z up out of the frame; nose-up pitch is a rotation about -Y. */
(function (root) {
  function rng(seed) {
    let a = seed >>> 0;
    const u = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    return { u, g: () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()), r: (lo, hi) => lo + (hi - lo) * u() };
  }
  const G = 9.81;

  // Track: features by horizontal position x (m). The gate sits at x = 0 on the start hill.
  const TRACK = {
    finishX: 190,
    gate: { drop: 4.0, len: 13 },                       // start hill: 4 m drop over 13 m (about 17 degrees)
    features: [
      { type: 'jump', x: 24, face: 3, gap: 4.5, land: 4, ht: 1.1, name: 'Double' },
      { type: 'roller', x: 37, len: 6, ht: 0.55 }, { type: 'roller', x: 43, len: 6, ht: 0.55 },
      { type: 'turn', x: 56, len: 22 },
      { type: 'roller', x: 82, len: 6, ht: 0.5 }, { type: 'roller', x: 88, len: 6, ht: 0.5 }, { type: 'roller', x: 94, len: 6, ht: 0.5 },
      { type: 'roller', x: 100, len: 6, ht: 0.5 }, { type: 'roller', x: 106, len: 6, ht: 0.5 },
      { type: 'turn', x: 114, len: 22 },
      { type: 'table', x: 142, face: 3, top: 4, back: 3, ht: 0.9, name: 'Tabletop' },
      { type: 'roller', x: 160, len: 6, ht: 0.45 }, { type: 'roller', x: 166, len: 6, ht: 0.45 },
    ]
  };
  const hc = t => (1 - Math.cos(Math.PI * t)) / 2;       // half-cosine 0..1
  function height(x, tr) {
    const gd = tr.gate;
    let h = x <= gd.len ? gd.drop * (1 - x / gd.len) : 0;
    // round off the bottom of the hill over 5 m
    if (x > gd.len - 2.5 && x < gd.len + 2.5) { const s = gd.drop / gd.len, u = x - (gd.len - 2.5); h = Math.max(0, s * 2.5 - s * u + s * u * u / 10); }
    for (const f of tr.features) {
      if (f.type === 'roller' && x >= f.x && x <= f.x + f.len) h += f.ht * (1 - Math.cos(2 * Math.PI * (x - f.x) / f.len)) / 2;
      if (f.type === 'jump') {
        if (x >= f.x && x <= f.x + f.face) h += f.ht * hc((x - f.x) / f.face);
        const l0 = f.x + f.face + f.gap;
        if (x >= l0 && x <= l0 + f.land) h += f.ht * (1 - hc((x - l0) / f.land));
      }
      if (f.type === 'table') {
        const a = f.x, b = a + f.face, c = b + f.top, d = c + f.back;
        if (x >= a && x < b) h += f.ht * hc((x - a) / f.face); else if (x >= b && x < c) h += f.ht; else if (x >= c && x <= d) h += f.ht * (1 - hc((x - c) / f.back));
      }
    }
    return h;
  }
  const slopeAt = (x, tr) => (height(x + 0.01, tr) - height(x - 0.01, tr)) / 0.02;
  const curvAt = (x, tr) => { const h1 = height(x - 0.05, tr), h0 = height(x, tr), h2 = height(x + 0.05, tr), d1 = (h2 - h1) / 0.1, d2 = (h2 - 2 * h0 + h1) / 0.0025; return d2 / Math.pow(1 + d1 * d1, 1.5); };
  function zoneAt(x, tr) {   // what the rider does here
    for (const f of tr.features) {
      if (f.type === 'roller' && x >= f.x - 0.5 && x <= f.x + f.len) return 'obstacle';
      if (f.type === 'jump' && x >= f.x - 0.5 && x <= f.x + f.face + f.gap + f.land) return 'obstacle';
      if (f.type === 'table' && x >= f.x - 0.5 && x <= f.x + f.face + f.top + f.back) return 'obstacle';
      if (f.type === 'turn' && x >= f.x && x <= f.x + f.len) return 'turn';
    }
    return 'flat';
  }

  // opts: seed, rate, ring, cog, circMm, wm, cm, rider (strength factor), pump (0..1 how much the rider pumps)
  function simulateLap(o) {
    o = Object.assign({ seed: 1, rate: 250, ring: 44, cog: 16, circMm: 1515, wm: 2, cm: 1, rider: 1, pump: 1, track: TRACK }, o || {});
    const R = rng(o.seed), tr = o.track, dt = 1 / o.rate, circ = o.circMm / 1000, ratio = o.ring / o.cog;
    const strength = o.rider * (1 + R.g() * 0.02);
    const tGate = 3.0;
    const imu = { t: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [] }, wheel = [], crank = [];
    const truth = { tGate, air: [], pumps: [], landings: [], finish: null, gateDrop: tr.gate.drop, trace: [] };
    const bias = [R.g() * 0.8, R.g() * 0.8, R.g() * 0.8];
    let x = 0, v = 0, t = 0, air = null, landT = -1, wheelV = 0, wheelDist = 0;
    let nextMag = R.r(0.05, 0.95) * circ / o.wm, crankPh = R.u(), th = Math.atan(slopeAt(0, tr)), thPrev = th;
    let stopT = null, pumpOn = null, brake = false, truthPush = 0;
    let done = false;
    while (!done) {
      const tau = t - tGate;
      let ft = 0, fn = 0, pedaling = false, pumping = false;
      if (tau < 0) {                                        // waiting on the gate
        th = Math.atan(slopeAt(0, tr));
        ft = G * Math.sin(th); fn = G * Math.cos(th);
      } else if (air) {                                     // in the air: free fall
        air.vy -= G * dt; air.x += air.vx * dt; air.y += air.vy * dt;
        const f = Math.min(1, (t - air.t0) / Math.max(0.2, air.Test));
        th = air.th0 + (air.th1 - air.th0) * f;
        if (air.y <= height(air.x, tr) && air.x > air.lipX + 0.5) {        // landed
          const sl = Math.atan(slopeAt(air.x, tr));
          v = Math.max(0, air.vx * Math.cos(sl) + air.vy * Math.sin(sl)) * 0.96;
          x = air.x; truth.air.push({ a: air.t0 - tGate, b: t - tGate, x0: air.lipX, x1: x });
          landT = t; truth.landings.push(t - tGate); air = null; th = sl;
        }
        x = air ? air.x : x;
        wheelV *= Math.pow(0.97, dt);                      // the wheel spins on in the air
      } else {
        const sl = slopeAt(x, tr), thG = Math.atan(sl), kap = curvAt(x, tr);
        const zone = zoneAt(x, tr);
        const cad = v / circ * 60 / ratio;
        let a = -G * Math.sin(thG) - 0.012 * v * v - 0.12;
        if (brake) a = v > 0 ? a - 4.0 : 0;
        else if (zone === 'flat') {                         // pedal the straights; coast and pump through obstacles and turns
          pedaling = tau < 0.12 ? tau > 0 : true;
          a += 9.5 / ratio * Math.max(0, 1 - cad / 150) * 1.7 * strength * Math.min(1, tau / 0.12 + 0.05);
        }
        let extraN = 0;
        if (zone === 'obstacle' && !brake && sl < -0.08) {   // pump the backside
          pumping = o.pump > 0;
          a += 1.4 * o.pump; extraN = 0.55 * G * o.pump;
        }
        v = Math.max(0, v + a * dt);
        x += v * Math.cos(thG) * dt;
        th = thG;
        fn = G * Math.cos(thG) + v * v * kap + extraN;
        ft = a + G * Math.sin(thG);
        if (landT >= 0 && t - landT < 0.12) fn += 2.6 * G * Math.exp(-(t - landT) / 0.03);
        if (fn < 0.45 * G) fn = 0.45 * G;              // over roller crests the rider absorbs: the frame stays light, not airborne
        wheelV = v;
        // launch off a jump lip
        for (const f of tr.features) if (f.type === 'jump' && !air && x >= f.x + f.face - 0.05 && x < f.x + f.face + 0.2 && v > 3) {
          const s2 = Math.atan(slopeAt(f.x + f.face - 0.1, tr));
          air = { t0: t, x: x, y: height(x - 0.02, tr), vx: v * Math.cos(s2), vy: v * Math.sin(s2), lipX: x, th0: s2,
            th1: Math.atan(slopeAt(f.x + f.face + f.gap + f.land * 0.5, tr)), Test: 2 * v * Math.sin(s2) / G + 0.15 };
        }
        truthPush = extraN / G;
        if (pumping && !pumpOn) pumpOn = { a: tau, x }; if (!pumping && pumpOn) { truth.pumps.push({ a: pumpOn.a, b: tau, x0: pumpOn.x, x1: x }); pumpOn = null; }
        if (truth.finish == null && x >= tr.finishX) { truth.finish = { t: tau, wheelD: wheelDist }; brake = true; }
        if (brake && v <= 0 && stopT == null) stopT = t;
      }
      // wheel and crank
      wheelDist += wheelV * dt; nextMag -= wheelV * dt;
      while (nextMag <= 0) { wheel.push(t + dt + nextMag / Math.max(wheelV, 1e-3)); nextMag += circ / o.wm; }
      if (pedaling) { crankPh += wheelV / circ / ratio * dt; while (crankPh >= 1) { crank.push(t); crankPh -= 1; } }
      // sensor
      // the frame can't rotate instantly (landings): limit to 600 deg/s like a real bike settling
      const maxStep = 600 * Math.PI / 180 * dt; if (th - thPrev > maxStep) th = thPrev + maxStep; else if (thPrev - th > maxStep) th = thPrev - maxStep;
      const thRate = (th - thPrev) / dt * 180 / Math.PI; thPrev = th;
      const moving = tau >= 0, vib = moving ? 0.05 : 0.006;
      const ftg = air ? 0 : ft / G, fng = air ? 0 : fn / G;
      imu.t.push(t);
      imu.ax.push(ftg + R.g() * vib); imu.ay.push(R.g() * vib * 0.6); imu.az.push(fng + R.g() * vib);
      imu.gx.push(bias[0] + R.g() * 0.5); imu.gy.push(bias[1] - thRate + R.g() * 0.5); imu.gz.push(bias[2] + R.g() * 0.5);
      if (Math.round(t * o.rate) % 5 === 0) truth.trace.push({ t: tau, x, v: air ? Math.hypot(air.vx, air.vy) : v, wheelD: wheelDist, h: air ? air.y : height(x, tr), th: th * 180 / Math.PI, pedaling, pumping, push: pumping ? truthPush : 0, air: !!air });
      t += dt;
      if (stopT != null && t - stopT > 3.2) done = true;
      if (t > 90) done = true;
    }
    const hdr = { version: 1, runId: o.runId || 1, rateHz: o.rate, imuType: 2, accLsbPerG: 2048, gyrLsbPerDps: 16.4, epoch: o.epoch || 0,
      wheelMagnets: o.wm, crankMagnets: o.cm, chainring: o.ring, cog: o.cog, wheelCircMm: o.circMm, forwardAxis: 0, label: o.label || 'sim lap', dataBytes: 0 };
    return { run: { hdr, imu, wheel, crank, marks: [], clipped: false }, truth };
  }

  // Encode as a logger run file (same 64-byte header + 16-byte records as the firmware).
  function toRunFile(run, startOffset) {
    const h = run.hdr, I = run.imu, ev = [];
    for (let i = 0; i < I.t.length; i++) ev.push([I.t[i], 0, i]);
    run.wheel.forEach(x => ev.push([x, 1])); run.crank.forEach(x => ev.push([x, 2])); run.marks.forEach(x => ev.push([x, 3]));
    ev.sort((a, b) => a[0] - b[0]);
    const off = startOffset || 0, buf = new ArrayBuffer(64 + 16 * ev.length), dv = new DataView(buf);
    dv.setUint32(0, 0x4C584D42, true); dv.setUint16(4, 1, true); dv.setUint32(8, h.runId, true); dv.setUint16(12, h.rateHz, true);
    dv.setUint8(14, h.imuType); dv.setFloat32(16, h.accLsbPerG, true); dv.setFloat32(20, h.gyrLsbPerDps, true); dv.setUint32(24, h.epoch, true);
    dv.setUint8(28, h.wheelMagnets); dv.setUint8(29, h.crankMagnets); dv.setUint8(30, h.chainring); dv.setUint8(31, h.cog);
    dv.setUint16(32, h.wheelCircMm, true); dv.setUint8(34, h.forwardAxis);
    for (let i = 0; i < Math.min(19, h.label.length); i++) dv.setUint8(36 + i, h.label.charCodeAt(i));
    dv.setUint32(56, 16 * ev.length, true);
    const cl = (v, s) => Math.max(-32767, Math.min(32767, Math.round(v * s)));
    ev.forEach((e, k) => {
      const o = 64 + 16 * k, us = Math.max(0, Math.round((e[0] + off) * 1e6));
      dv.setUint32(o, (us & 0x3FFFFFFF) | (e[1] << 30) >>> 0, true);
      if (e[1] === 0) { const i = e[2]; [I.ax[i], I.ay[i], I.az[i]].forEach((v, j) => dv.setInt16(o + 4 + 2 * j, cl(v, h.accLsbPerG), true)); [I.gx[i], I.gy[i], I.gz[i]].forEach((v, j) => dv.setInt16(o + 10 + 2 * j, cl(v, h.gyrLsbPerDps), true)); }
    });
    return buf;
  }

  const api = { simulateLap, toRunFile, TRACK, height };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BmxTrackSim = api;
})(typeof window !== 'undefined' ? window : this);
