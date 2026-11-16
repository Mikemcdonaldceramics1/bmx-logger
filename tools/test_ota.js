// Firmware update over Bluetooth, end to end against the simulated logger.
// node tools/test_ota.js   (from the repo root; needs Playwright)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const fwBin = crypto.randomBytes(300 * 1024); fwBin[0] = 0xE9;           // looks like an ESP32 app image
const fwJson = { version: 6, size: fwBin.length, sha256: crypto.createHash('sha256').update(fwBin).digest('hex'), commit: 'abc1234' };

async function session(b, { native = false, mtu = 185, pre = '' } = {}) {
  const page = await b.newPage({ viewport: { width: 412, height: 860 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://raw.githubusercontent.com/**', r => {
    const u = r.request().url();
    if (u.includes('fw.json')) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fwJson) });
    if (u.includes('app.bin')) return r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: fwBin });
    return r.fulfill({ status: 404 });
  });
  await page.addInitScript(`window.__realFetch = window.fetch; window.__fakeMtu = ${mtu}; ${pre}\n` +
    read('tools/demo_logger.js') + '\n' + read('tools/fake_bluetooth.js') + '\n' + (native ? read('android_app/test/fake_native.js') : ''));
  await page.goto('file://' + path.join(root, 'index.html'));
  await page.click('#bleBtn');
  await page.waitForFunction(() => document.getElementById('conn').textContent === 'connected');
  await page.click('nav >> text=Settings');
  return { page, errors };
}

(async () => {
  const b = await chromium.launch();
  for (const [name, opts] of [['web, MTU 185', {}], ['native app, MTU 247', { native: true, mtu: 247 }], ['web, MTU 23', { mtu: 23 }]]) {
    const { page, errors } = await session(b, opts);
    await page.waitForFunction(() => /build 5.*Latest: build 6/.test(document.getElementById('fwInfo').textContent));
    if (await page.textContent('#fwUpdate') !== 'Update to build 6') throw new Error('button text');
    const t0 = Date.now();
    await page.click('#fwUpdate');
    await page.waitForFunction(() => /Installed/.test(document.getElementById('fwMsg').textContent), null, { timeout: 120000 });
    const same = await page.evaluate(h => window.__otaInstalled && [...window.__otaInstalled].map(x => x.toString(16).padStart(2, '0')).join('') === h,
      fwBin.toString('hex'));
    if (!same) throw new Error('installed bytes differ');
    // the logger restarts; the app reconnects and shows the new build
    await page.evaluate(() => setTimeout(() => window.__fakeDevice.gatt.connected || document.getElementById('bleBtn').click(), 500));
    await page.waitForFunction(() => /build 6.*Up to date/.test(document.getElementById('fwInfo').textContent), null, { timeout: 20000 });
    if (errors.length) throw new Error(errors.join('; '));
    console.log(`${name}: installed ${fwBin.length} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s, reconnected on build 6`);
    if (name.startsWith('native')) await page.screenshot({ path: process.env.SHOT || '/dev/null' }).catch(() => {});
    await page.close();
  }
  {   // damaged transfer: the logger rejects it and keeps its firmware
    const { page } = await session(b, { pre: 'window.__fakeOtaCorrupt = true;' });
    await page.waitForFunction(() => !document.getElementById('fwUpdate').disabled);
    await page.click('#fwUpdate');
    await page.waitForFunction(() => /checksum mismatch/.test(document.getElementById('fwErr').textContent), null, { timeout: 60000 });
    console.log('corrupted transfer: ' + await page.textContent('#fwErr'));
    await page.close();
  }
  {   // old firmware without the update characteristic
    const { page } = await session(b, { native: true, pre: 'window.__fakeNoOta = true;' });
    await page.waitForFunction(() => /too old/.test(document.getElementById('fwInfo').textContent));
    if (!(await page.isDisabled('#fwUpdate'))) throw new Error('button should be disabled');
    console.log('old firmware: ' + await page.textContent('#fwInfo'));
    await page.close();
  }
  {   // a merged USB image picked by mistake is refused before anything is sent
    const { page } = await session(b);
    await page.waitForFunction(() => !document.getElementById('fwFile').disabled);
    await page.setInputFiles('#fwFile', { name: 'bmx_logger_merged.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(4096, 0xff) });
    await page.waitForFunction(() => /not ESP32 firmware/.test(document.getElementById('fwErr').textContent));
    console.log('wrong file: ' + await page.textContent('#fwErr'));
    await page.close();
  }
  await b.close();
  console.log('firmware update tests passed');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
