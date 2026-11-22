// Start timing accuracy on synthetic gate starts with known truth.
// node tools/test_start_timing.js [--baseline]
const fs = require('fs'), path = require('path'), vm = require('vm');
const { makeRun } = require('./start_sim');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const ctx = { module: { exports: {} } };
vm.runInNewContext(html.match(/<script id="analysis">([\s\S]*?)<\/script>/)[1], ctx);
const BMX = ctx.module.exports;
const M = [5, 10, 20];

function trial(name, opts, n) {
  const errs = { 5: [], 10: [], 20: [] }, cover = [], methods = {}, warnings = {};
  for (let i = 0; i < n; i++) {
    const { run, truth } = makeRun(Object.assign({ seed: 1000 + i }, opts));
    const r = BMX.analyze(run, { splitsM: M });
    const st = r.start || {};
    methods[st.method || 'none'] = (methods[st.method || 'none'] || 0) + 1;
    for (const w of r.warnings) { const k = w.slice(0, 40); warnings[k] = (warnings[k] || 0) + 1; }
    r.splits.forEach(s => {
      const e = s.t - truth.cross[s.m];
      errs[s.m].push(e);
      if (s.unc != null) cover.push(Math.abs(e) <= s.unc);
    });
  }
  const stat = a => { const ab = a.map(Math.abs).sort((x, y) => x - y); return { mean: a.reduce((s, x) => s + x, 0) / a.length, p90: ab[Math.floor(0.9 * ab.length)], max: ab[ab.length - 1] }; };
  const out = {};
  console.log(`\n${name} (${n} runs) methods: ${JSON.stringify(methods)}`);
  for (const m of M) {
    const s = stat(errs[m]); out[m] = s;
    console.log(`  ${m} m split error: bias ${(s.mean * 1000).toFixed(0)} ms, 90% within ${(s.p90 * 1000).toFixed(0)} ms, worst ${(s.max * 1000).toFixed(0)} ms`);
  }
  if (cover.length) console.log(`  reported ± covers the true error ${(100 * cover.filter(Boolean).length / cover.length).toFixed(0)}% of the time`);
  if (Object.keys(warnings).length) console.log('  warnings: ' + JSON.stringify(warnings));
  return { out, cover: cover.length ? cover.filter(Boolean).length / cover.length : null };
}
const res = {
  standard: trial('gate starts, 2 magnets', {}, 300),
  uneven: trial('gate starts, magnets unevenly spaced (45/55)', { uneven: 0.45 }, 200),
  noImu: trial('gate starts, no motion sensor data', { noImu: true }, 200),
  glitch: trial('gate starts with a glitch pulse before the drop', { glitch: true }, 200),
  rolling: trial('rolling start (already moving)', { rolling: true }, 50),
  hz100: trial('gate starts at 100 Hz', { rate: 100 }, 100),
};
if (process.argv.includes('--baseline')) process.exit(0);
const fail = [];
const need = (ok, msg) => { if (!ok) fail.push(msg); };
need(res.standard.out[5].p90 < 0.025 && res.standard.out[10].p90 < 0.025, 'standard: 90% of 5/10 m splits within 25 ms');
need(Math.abs(res.standard.out[5].mean) < 0.01, 'standard: no bias over 10 ms');
need(res.standard.cover > 0.85, 'standard: ± covers 85%');
need(res.uneven.out[10].p90 < 0.03, 'uneven magnets: 90% within 30 ms');
need(res.glitch.out[5].p90 < 0.03, 'glitch pulse ignored: 90% within 30 ms');
need(res.noImu.out[5].p90 < 0.1 && res.noImu.cover > 0.8, 'no IMU: wheel-only fit within 100 ms, ± honest');
need(res.hz100.out[5].p90 < 0.035, '100 Hz: within 35 ms');
if (fail.length) { console.error('\nFAILED:\n  ' + fail.join('\n  ')); process.exit(1); }
console.log('\nstart timing tests passed');
