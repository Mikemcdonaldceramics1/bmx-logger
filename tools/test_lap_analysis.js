// Lap analysis on simulated laps with known truth: airtime, obstacles, pumping, elevation, lap time.
// node tools/test_lap_analysis.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const S = require('./track_sim');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const ctx = { module: { exports: {} } };
vm.runInNewContext(html.match(/<script id="analysis">([\s\S]*?)<\/script>/)[1], ctx);
const B = ctx.module.exports;
const fail = [], f = x => (x == null ? '-' : (+x).toFixed(2));
const need = (ok, msg) => { if (!ok) fail.push(msg); };
let tot = { pumps: 0, found: 0, extra: 0 };
for (const [seed, opts] of [[1, {}], [2, { ring: 41 }], [3, {}], [4, { rider: 0.9 }], [5, { rate: 100 }], [6, { pump: 0 }], [7, { wm: 1 }], [8, { ring: 45, cog: 15 }]]) {
  const { run, truth } = S.simulateLap(Object.assign({ seed }, opts));
  const r = B.analyze(run, { splitsM: [5, 10], finishM: truth.finish.wheelD });
  const st = r.stats, tag = `seed ${seed} ${JSON.stringify(opts)}`;
  // lap time to the finish line distance
  need(Math.abs(st.lapTime - truth.finish.t) < 0.1, `${tag}: lap ${f(st.lapTime)} vs ${f(truth.finish.t)}`);
  // airtime: the double, and nothing else
  need(r.air.length === truth.air.length && r.air.every((a, k) => Math.abs(a.a - truth.air[k].a) < 0.08 && Math.abs(a.b - truth.air[k].b) < 0.08),
    `${tag}: air ${JSON.stringify(r.air.map(a => [f(a.a), f(a.b)]))} vs ${JSON.stringify(truth.air.map(a => [f(a.a), f(a.b)]))}`);
  // obstacles: 11 on this track (1 jump, 9 rollers, 1 table)
  const kinds = r.obstacles.reduce((m, x) => (m[x.type] = (m[x.type] || 0) + 1, m), {});
  need(Math.abs(r.obstacles.length - 11) <= 1 && kinds.jump === 1 && kinds.table === 1, `${tag}: obstacles ${JSON.stringify(kinds)}`);
  // elevation
  need(Math.abs(st.elevation.startHill - 4) < 1.2, `${tag}: start hill ${f(st.elevation.startHill)} m vs 4`);
  need(Math.abs(st.elevation.gain - 6.5) < 2, `${tag}: gain ${f(st.elevation.gain)} m vs about 6.5`);
  // pumping: every pump the rider made is found (within 0.4 s); a rider who doesn't pump shows few
  for (const q of truth.pumps) { tot.pumps++; if (r.pumps.some(p => Math.abs(p.a - q.a) < 0.4 || (q.a >= p.a && q.a <= p.b))) tot.found++; }
  tot.extra += r.pumps.filter(p => !truth.pumps.some(q => Math.abs(p.a - q.a) < 0.4 || (q.a >= p.a && q.a <= p.b))).length;
  if (opts.pump === 0) need(r.pumps.length <= 3, `${tag}: no pumping rider shows ${r.pumps.length} pumps`);
  console.log(`${tag}: lap ${f(st.lapTime)} (truth ${f(truth.finish.t)}), air ${r.air.length}, obstacles ${r.obstacles.length} ${JSON.stringify(kinds)}, ` +
    `hill ${f(st.elevation.startHill)} m, gain ${f(st.elevation.gain)} m, pumps ${r.pumps.length}/${truth.pumps.length}, crank avg ${f(st.crankRpm.avg)} rpm`);
}
console.log(`pumps found: ${tot.found}/${tot.pumps}, extra detections: ${tot.extra}`);
need(tot.found / tot.pumps > 0.85, 'pump recall over 85%');
need(tot.extra / tot.pumps < 0.35, 'extra pump detections under 35%');
if (fail.length) { console.error('\nFAILED:\n  ' + fail.join('\n  ')); process.exit(1); }
console.log('lap analysis tests passed');
