/* Simulated logger for the shareable demo: answers the app's /api calls in the browser.
   A virtual rider launches from a gate; smaller gears jump faster, bigger gears carry more top speed. */
window.BMX_DEMO = true;
(() => {
  const cfg = { wheelCircMm: 1515, wheelMagnets: 2, crankMagnets: 1, chainring: 44, cog: 16, forwardAxis: 0, rateHz: 250, autoStopS: 5 };
  const SLOTS = 7;
  let runs = [], nextId = 1, state = 'idle', rec = null, pulses = { w: 0, c: 0 };

  function rng(seed) {
    let a = seed >>> 0;
    const u = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    return { u, g: () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()) };
  }

  // Same rider model as tools/simulate_run.py
  function simulate(o) {
    const R = rng(o.seed), circ = o.circMm / 1000, ratio = o.ring / o.cog, rate = o.rate, dt = 1 / rate;
    const acc_lsb = 2048, gyr_lsb = 16.4, still = 1.5, T = still + 13;
    const coast = [[4.0, 5.0], [7.0, 8.2]], strength = 1 + R.g() * 0.025;
    let v = 0, dist = 0, crank = 0, t = 0, pitch = 0, wNext = circ / o.wm, cNext = 1 / o.cm, acc = 0;
    const recs = [], trace = [];
    const push = (tt, type, vals) => recs.push([tt, type, vals || [0, 0, 0, 0, 0, 0]]);
    let traceNext = 0;
    while (t < T) {
      const tl = t - still;
      const pedaling = tl >= 0 && !coast.some(([s, e]) => tl >= s && tl < e) && tl < 10;
      if (tl >= 0) {
        const cad = v / circ * 60 / ratio;
        const force = pedaling ? 9 / ratio * Math.max(0, 1 - cad / 150) * 1.6 * strength : 0;
        acc = tl > 10 ? -1.5 : force - 0.02 * v * v - 0.15;
        v = Math.max(0, v + acc * dt); dist += v * dt;
        if (pedaling) crank += v / circ / ratio * dt;
      }
      while (dist >= wNext) { push(t, 1); wNext += circ / o.wm; }
      while (crank >= cNext) { push(t, 2); cNext += 1 / o.cm; }
      let target = 0;
      for (const [s, e] of coast) if (tl >= s && tl < e) target = 20 * Math.sin((tl - s) / (e - s) * 2 * Math.PI);
      const prate = (target - pitch) / dt * 0.05; pitch += prate * dt;
      const p = pitch * Math.PI / 180, lin = tl >= 0 ? acc / 9.81 : 0;
      let land = 0; for (const [, e] of coast) if (Math.abs(tl - e) < 0.02) land = 3.5;
      const ax = (Math.sin(p) + lin) * acc_lsb + R.g() * 15, az = (Math.cos(p) + land) * acc_lsb + R.g() * 15;
      push(t, 0, [ax, R.g() * 15, az, R.g() * 5, -prate * gyr_lsb + R.g() * 5, R.g() * 5]);
      if (t >= traceNext) {
        trace.push({ t, kmh: v * 3.6, rpm: pedaling ? v / circ * 60 / ratio : 0, ax: ax / acc_lsb, az: az / acc_lsb, w: 0, c: 0 });
        traceNext += 0.05;
      }
      t += dt;
    }
    let w = 0, c = 0, k = 0;
    for (const r of recs) { while (k < trace.length && trace[k].t < r[0]) { trace[k].w = w; trace[k].c = c; k++; } if (r[1] === 1) w++; if (r[1] === 2) c++; }
    for (; k < trace.length; k++) { trace[k].w = w; trace[k].c = c; }
    return { recs, trace, duration: T };
  }

  function encode(sim, meta, untilT) {
    const recs = untilT == null ? sim.recs : sim.recs.filter(r => r[0] <= untilT);
    const buf = new ArrayBuffer(64 + recs.length * 16), dv = new DataView(buf);
    dv.setUint32(0, 0x4C584D42, true); dv.setUint16(4, 1, true); dv.setUint16(6, 64, true);
    dv.setUint32(8, meta.id, true); dv.setUint16(12, meta.rate, true); dv.setUint8(14, 1);
    dv.setFloat32(16, 2048, true); dv.setFloat32(20, 16.4, true); dv.setUint32(24, meta.epoch, true);
    dv.setUint8(28, meta.wm); dv.setUint8(29, meta.cm); dv.setUint8(30, meta.ring); dv.setUint8(31, meta.cog);
    dv.setUint16(32, meta.circMm, true); dv.setUint8(34, meta.fwd);
    const lab = (meta.label || '').slice(0, 19);
    for (let i = 0; i < lab.length; i++) dv.setUint8(36 + i, lab.charCodeAt(i) & 0x7f);
    dv.setUint32(56, recs.length * 16, true); dv.setUint32(60, 0xFFFFFFFF, true);
    recs.forEach((r, i) => {
      const o = 64 + i * 16;
      dv.setUint32(o, ((Math.round(r[0] * 1e6) & 0x3FFFFFFF) | (r[1] << 30)) >>> 0, true);
      r[2].forEach((x, j) => dv.setInt16(o + 4 + 2 * j, Math.max(-32768, Math.min(32767, Math.round(x))), true));
    });
    return buf;
  }

  function addRun(label, ring, cog, seed, epoch, untilT, sim) {
    const meta = { id: nextId++, rate: cfg.rateHz, epoch, wm: cfg.wheelMagnets, cm: cfg.crankMagnets, ring, cog, circMm: cfg.wheelCircMm, fwd: cfg.forwardAxis, label };
    sim = sim || simulate({ seed, ring, cog, circMm: cfg.wheelCircMm, wm: cfg.wheelMagnets, cm: cfg.crankMagnets, rate: cfg.rateHz });
    const buf = encode(sim, meta, untilT);
    runs.push({ id: meta.id, epoch, bytes: buf.byteLength - 64, rateHz: meta.rate, chainring: ring, cog, closed: true, label, buf });
    if (runs.length > SLOTS) runs.shift();
    return meta.id;
  }

  // two example runs so the Analyze tab has something to show on first open
  const now = Math.floor(Date.now() / 1000);
  addRun('44/16 example', 44, 16, 11, now - 1500);
  addRun('41/16 example', 41, 16, 12, now - 900);
  try { if (!localStorage.getItem('sel')) localStorage.setItem('sel', JSON.stringify(['dev:1', 'dev:2'])); } catch (e) {}

  function tick() {
    if (!rec) return;
    const el = (performance.now() - rec.t0) / 1000;
    if (state === 'preparing' && el > 1.2) { state = 'recording'; rec.t0 = performance.now(); }
    else if (state === 'recording' && (el >= rec.sim.duration || rec.stop)) {
      rec.end = Math.min(el, rec.sim.duration); state = 'saving'; rec.saveAt = performance.now() + 700;
    } else if (state === 'saving' && performance.now() > rec.saveAt) {
      addRun(rec.label, rec.ring, rec.cog, rec.seed, rec.epoch, rec.end, rec.sim);
      state = 'idle'; rec = null;
    }
  }
  setInterval(tick, 100);

  function status() {
    tick();
    const base = { state, imu: 'MPU-6050 (simulated)', imuErrors: 0, slots: SLOTS, used: runs.length, run: rec ? nextId : 0, elapsedMs: 0,
      bytes: 0, cap: 327616, overflow: 0, wheelPulses: pulses.w, crankPulses: pulses.c, wheelRpm: 0, crankRpm: 0, kmh: 0, ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, err: '' };
    if (state === 'recording') {
      const el = (performance.now() - rec.t0) / 1000, tr = rec.sim.trace;
      const s = tr[Math.min(tr.length - 1, Math.floor(el / 0.05))];
      Object.assign(base, { elapsedMs: el * 1000, bytes: Math.round(el * 4700), kmh: s.kmh, crankRpm: s.rpm, ax: s.ax, az: s.az,
        wheelPulses: pulses.w + s.w, crankPulses: pulses.c + s.c });
    }
    return base;
  }

  const json = (o, code) => new Response(JSON.stringify(o), { status: code || 200, headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opt) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, opt);
    const u = new URL(url, 'http://demo'), p = Object.fromEntries(new URLSearchParams(opt && opt.body ? String(opt.body) : u.search));
    await new Promise(r => setTimeout(r, 40));
    switch (u.pathname) {
      case '/api/status': return json(status());
      case '/api/settings':
        if (opt && opt.method === 'POST') {
          if (state !== 'idle') return json({ ok: false, err: 'busy' }, 409);
          for (const k of Object.keys(cfg)) if (p[k] != null && p[k] !== '') cfg[k] = +p[k];
        }
        return json(cfg);
      case '/api/arm': {
        if (state !== 'idle') return json({ ok: false, err: 'busy' }, 409);
        const ring = +p.chainring || cfg.chainring, cog = +p.cog || cfg.cog;
        cfg.chainring = ring; cfg.cog = cog;
        const seed = (Math.random() * 1e9) | 0;
        rec = { t0: performance.now(), label: p.label || `${ring}/${cog}`, ring, cog, seed, epoch: +p.epoch || Math.floor(Date.now() / 1000),
          sim: simulate({ seed, ring, cog, circMm: cfg.wheelCircMm, wm: cfg.wheelMagnets, cm: cfg.crankMagnets, rate: cfg.rateHz }) };
        state = 'preparing';
        return json({ ok: true });
      }
      case '/api/stop': if (rec && state === 'recording') rec.stop = true; return json({ ok: true });
      case '/api/mark': return json({ ok: true });
      case '/api/runs': return json(runs.map(({ buf, ...r }) => r));
      case '/api/run': {
        const r = runs.find(x => x.id === +u.searchParams.get('id'));
        return r ? new Response(r.buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } }) : json({ err: 'not found' }, 404);
      }
      case '/api/delete': runs = runs.filter(x => x.id !== +p.id); return json({ ok: true });
    }
    return json({ err: 'not found' }, 404);
  };
})();
