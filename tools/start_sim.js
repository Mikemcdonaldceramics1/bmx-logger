// Synthetic gate starts with known truth, for testing the start-timing analysis.
// Sensor frame: +X forward (forwardAxis 0), +Z up. Accelerometer reads specific force in g, gyro in deg/s.
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  return { u, g: () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()), r: (lo, hi) => lo + (hi - lo) * u() };
}

// opts: seed, wm (wheel magnets), uneven (fraction of the circumference between magnet 1 and 2), noImu,
//       rolling (already moving at the start of the record), glitch (spurious wheel pulse while still), rate
function makeRun(o) {
  const R = rng(o.seed), rate = o.rate || 250, dt = 1 / rate, circ = 1.515, wm = o.wm || 2;
  const frac = wm === 2 ? [o.uneven || 0.5, 1 - (o.uneven || 0.5)] : Array(wm).fill(1 / wm);
  const tOn = o.rolling ? 0 : R.r(2.6, 3.3);                 // true movement onset
  const A = R.r(5.0, 7.5), ramp = R.r(0.08, 0.2);            // launch acceleration (m/s^2) and how fast it builds
  const strokeT = R.r(0.38, 0.5), strokeAmp = R.r(0.2, 0.45);
  const T = tOn + 12;
  const gyroBias = [R.g() * 1.2, R.g() * 1.2, R.g() * 1.2];
  const rock = R.r(1, 5), rockT = R.r(0.3, 0.8);              // rider rocks the bike nose-up before the drop
  // where the wheel magnets are when the bike starts: distance to the next magnet pass
  const phase = R.u();
  let slot = 0, toNext = (o.rolling ? 0.3 : phase * frac[0] * circ) || 1e-3;   // the gap before the first pulse is slot 0, then slot 1...
  let v = o.rolling ? 6 : 0, x = 0, th = 0, crankPhase = R.u(), ratio = 44 / 16;
  const imu = { t: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [] }, wheel = [], crank = [];
  const truth = { tOn, cross: {} };
  const marks = [5, 10, 20, 30];
  for (let t = 0; t < T; t += dt) {
    const tau = t - tOn;
    let a = 0;
    if (o.rolling) a = 1.5 * (1 + 0.3 * Math.sin(2 * Math.PI * t / strokeT));
    else if (tau >= 0) {
      const env = Math.min(1, tau / ramp) * (tau < 1.2 ? 1 : Math.exp(-(tau - 1.2) / 1.8));
      a = A * env * (1 + strokeAmp * Math.sin(2 * Math.PI * tau / strokeT)) - 0.015 * v * v;
      if (v <= 0 && a < 0) a = 0;
    }
    // pitch: rock before the drop, front lifts on the first stroke, then pedalling wobble
    let thT = 0;
    if (!o.rolling && tau < 0 && tau > -rockT) thT = rock * Math.sin(Math.PI * (-tau) / rockT);
    else if (tau >= 0 && tau < 0.5) thT = 4 * Math.sin(Math.PI * tau / 0.5);
    else if (tau >= 0.5) thT = 1.5 * Math.sin(2 * Math.PI * tau / strokeT);
    const thRate = (thT - th) / dt; th = thT;
    const thr = th * Math.PI / 180;
    // specific force in world (forward, up) -> body
    const fw = a / 9.81, up = 1 + (tau > 0 ? 0.05 * R.g() : 0);
    const ax = Math.cos(thr) * fw + Math.sin(thr) * up, az = -Math.sin(thr) * fw + Math.cos(thr) * up;
    const vib = tau > 0 || o.rolling ? 0.04 : 0.008;
    imu.t.push(t);
    imu.ax.push(ax + R.g() * vib); imu.ay.push(R.g() * vib); imu.az.push(az + R.g() * vib);
    imu.gx.push(gyroBias[0] + R.g() * 0.4); imu.gy.push(gyroBias[1] - thRate + R.g() * 0.4); imu.gz.push(gyroBias[2] + R.g() * 0.4);
    // motion
    const dx = v * dt + 0.5 * a * dt * dt; v = Math.max(0, v + a * dt); x += dx;
    toNext -= dx;
    while (toNext <= 0) { wheel.push(t + dt + toNext / Math.max(v, 1e-3)); slot = (slot + 1) % wm; toNext += frac[slot] * circ; }
    if (tau >= 0 || o.rolling) {
      crankPhase += v / circ / ratio * dt;
      while (crankPhase >= 1) { crank.push(t); crankPhase -= 1; }
    }
    for (const m of marks) if (truth.cross[m] == null && x >= m) truth.cross[m] = t + dt - (x - m) / Math.max(v, 1e-3) - tOn;
  }
  if (o.glitch) wheel.push(tOn - R.r(0.4, 1.2));
  wheel.sort((p, q) => p - q);
  if (o.noImu) for (const k in imu) imu[k] = [];
  const hdr = { version: 1, runId: 1, rateHz: rate, imuType: 2, accLsbPerG: 2048, gyrLsbPerDps: 16.4, epoch: 0, wheelMagnets: wm, crankMagnets: 1,
    chainring: 44, cog: 16, wheelCircMm: 1515, forwardAxis: 0, label: 'sim', dataBytes: 0 };
  return { run: { hdr, imu, wheel, crank, marks: [], clipped: false }, truth };
}
module.exports = { makeRun };
