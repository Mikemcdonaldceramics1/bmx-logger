// Runs are copied to the phone automatically and survive a restart of the app.
// node tools/test_history.js   (from the repo root; needs Playwright)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 412, height: 900 } });
  await ctx.addInitScript(fs.readFileSync(path.join(root, 'tools/demo_logger.js'), 'utf8'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // serve over http so IndexedDB persists between page loads
  await ctx.route('http://app.test/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(root, 'index.html')) }));
  await page.goto('http://app.test/index.html');
  await page.waitForFunction(() => /All runs copied to this phone \(2 saved\)/.test(document.getElementById('syncNote').textContent), null, { timeout: 15000 });
  console.log('on connect: ' + await page.textContent('#syncNote'));

  // record a run: it is copied as soon as the logger re-arms
  await page.click('#armBtn');
  await page.waitForFunction(() => document.getElementById('st').textContent === 'recording', null, { timeout: 30000 });
  await page.waitForFunction(() => /\(3 saved\)/.test(document.getElementById('syncNote').textContent), null, { timeout: 60000 });
  console.log('after a run: ' + await page.textContent('#syncNote') + ' (state ' + await page.textContent('#st') + ')');
  await page.click('#armBtn');   // disarm

  // runs tab shows the history and marks logger runs as saved
  await page.click('nav button[data-tab="runs"]');
  await page.waitForTimeout(800);
  const histRows = await page.$$eval('#histList .run', r => r.length), saved = await page.$$eval('#runList .saved', r => r.length);
  if (histRows !== 3 || saved !== 3) throw new Error(`history ${histRows}, saved marks ${saved}`);
  console.log(`runs tab: ${histRows} runs on the phone, ${saved} logger runs marked saved`);

  // reload with the logger "gone": the history is still there and analyzes
  await ctx.unroute('http://app.test/**');
  await ctx.route('http://app.test/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(root, 'index.html')) }));
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => { window.__noLogger = true; });
  await p2.goto('http://app.test/index.html');
  await p2.click('nav button[data-tab="runs"]');
  await p2.waitForFunction(() => document.querySelectorAll('#histList .run').length === 3);
  for (const c of await p2.$$('#histList input[type=checkbox]')) await c.check();
  await p2.click('#compareBtn');
  await p2.waitForFunction(() => document.querySelectorAll('#summary tr').length >= 4, null, { timeout: 15000 });
  console.log('after reopening the app: 3 saved runs analyzed from the phone');

  // deleting from the phone
  await p2.click('nav button[data-tab="runs"]');
  await p2.waitForTimeout(500);
  const btns = await p2.$$('#histList .run button:has-text("Delete")');
  await btns[0].click(); await btns[0].click();
  await p2.waitForFunction(() => document.querySelectorAll('#histList .run').length === 2);
  // reconnecting does not copy the deleted run back
  await p2.evaluate(() => sync.run());
  await p2.waitForTimeout(1500);
  if (await p2.$$eval('#histList .run', r => r.length) !== 2) throw new Error('deleted run came back');
  console.log('delete from phone: 2 left, and it is not copied back on the next connect');
  if (errors.length) throw new Error(errors.join('; '));
  await b.close();
  console.log('history tests passed');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
