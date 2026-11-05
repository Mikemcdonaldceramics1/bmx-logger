// node tools/test_analysis.js run1.bin run2.bin ...  -> runs the app's analysis code on run files
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/<script id="analysis">([\s\S]*?)<\/script>/)[1];
const ctx = { module: { exports: {} } };
vm.runInNewContext(src, ctx);
const BMX = ctx.module.exports;
for (const f of process.argv.slice(2)) {
  const b = fs.readFileSync(f);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const run = BMX.parseRun(buf);
  const r = BMX.analyze(run, { splitsM: [5, 10, 20, 30] });
  const fx = (x, d = 2) => (x == null ? '-' : x.toFixed(d));
  console.log(`\n${f}: run #${run.hdr.runId} ${run.hdr.chainring}/${run.hdr.cog} imu=${run.imu.t.length} wheel=${run.wheel.length} crank=${run.crank.length}`);
  console.log(' splits', r.splits.map(s => `${s.m}m=${fx(s.t)}s`).join(' '));
  console.log(` peak ${fx(r.peakSpeed)} m/s at ${fx(r.peakT)} s, peak cad ${fx(r.peakCadence, 0)}, ratio meas ${fx(r.measuredRatio, 3)} exp ${fx(r.expectedRatio, 3)}, pedal ${fx(r.pedalPct, 0)}%, peakG ${fx(r.peakG)}, rollout ${fx(r.rolloutM)} m`);
  console.log(' bands', r.bands.map(b => `${b.state}:${fx(b.a, 1)}-${fx(b.b, 1)}`).join(' '));
  const p = r.imu.pitch; console.log(` pitch range ${fx(Math.min(...p), 1)}..${fx(Math.max(...p), 1)} deg; warnings: ${r.warnings.join(' | ') || 'none'}`);
  console.log(' csv lines', BMX.toCsv(run, r).split('\n').length);
}
