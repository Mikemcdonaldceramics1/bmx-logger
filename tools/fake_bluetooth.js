/* Test double for navigator.bluetooth: a simulated BMX logger that speaks the same framed
   protocol as the firmware (see bmx_logger/ble_proto.h). It reuses web/demo_logger.js for
   the logger's behaviour and only adds the Bluetooth framing. Load demo_logger.js first. */
(() => {
  const demoFetch = window.fetch;          // patched by demo_logger.js
  window.fetch = window.__realFetch;       // the app must not see the demo's HTTP API
  delete window.BMX_DEMO;

  const MTU = window.__fakeMtu || 185;
  const PAY = Math.min(508, MTU - 4);
  const SVC = '6e7a0001-3b2c-4d1a-9f5e-8b6c4d2a1f00', CMD = '6e7a0002-3b2c-4d1a-9f5e-8b6c4d2a1f00',
        RESP = '6e7a0003-3b2c-4d1a-9f5e-8b6c4d2a1f00', STAT = '6e7a0004-3b2c-4d1a-9f5e-8b6c4d2a1f00',
        OTA = '6e7a0005-3b2c-4d1a-9f5e-8b6c4d2a1f00';
  // Firmware update simulation, same rules as the firmware: 16 KB receive buffer, flash written
  // 4 KB at a time, progress {"ota":n} on the status channel, SHA-256 checked at the end.
  window.__fakeFw = window.__fakeFw ?? 5;
  const ota = { active: false, size: 0, sha: '', buf: [], queued: 0, written: 0, parts: [] };
  window.__ota = ota;
  let wifi = false;
  window.__bleLog = [];

  class Chr extends EventTarget {
    constructor(uuid) { super(); this.uuid = uuid; this.notifying = false; }
    async startNotifications() { this.notifying = true; return this; }
    async writeValueWithResponse(buf) {
      if (!dev.gatt.connected) throw new Error('GATT Server is disconnected.');
      const text = new TextDecoder().decode(buf);
      window.__bleLog.push(text);
      setTimeout(() => handle(text), 5);
    }
  }
  const chrs = { [CMD]: new Chr(CMD), [RESP]: new Chr(RESP), [STAT]: new Chr(STAT) };
  if (!window.__fakeNoOta) {
    chrs[OTA] = new Chr(OTA);
    chrs[OTA].writeValueWithoutResponse = async buf => {
      if (!dev.gatt.connected) throw new Error('GATT Server is disconnected.');
      const b = new Uint8Array(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
      if (b.length > MTU - 3) throw new Error('write longer than MTU');
      if (!ota.active) return;
      ota.buf.push(b); ota.queued += b.length;
      if (ota.queued > 16384) { ota.active = false; sendJson(chrs[STAT], { otaErr: 'data arrived too fast' }); }
    };
    setInterval(async () => {
      if (!ota.active || !ota.queued) return;
      let n = 0;                                   // "flash write": up to 4 KB per tick
      while (ota.buf.length && n < 4096) { const c = ota.buf.shift(); ota.parts.push(c); n += c.length; ota.queued -= c.length; }
      const before = ota.written; ota.written += n;
      if (ota.written === ota.size) {
        ota.active = false;
        const all = new Uint8Array(ota.size); let o = 0; for (const c of ota.parts) { all.set(c, o); o += c.length; }
        if (window.__fakeOtaCorrupt) all[100] ^= 1;
        const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map(x => x.toString(16).padStart(2, '0')).join('');
        if (sha !== ota.sha) { sendJson(chrs[STAT], { otaErr: 'checksum mismatch - nothing changed' }); return; }
        sendJson(chrs[STAT], { ota: ota.size, done: true });
        window.__fakeFw = window.__fakeNextFw || window.__fakeFw + 1;
        window.__otaInstalled = all;
        setTimeout(() => dev.gatt.disconnect(), 300);      // restart
      } else if (Math.floor(ota.written / 4096) > Math.floor(before / 4096)) sendJson(chrs[STAT], { ota: ota.written });
    }, 15);
  }

  function sendFramed(chr, type, bytes) {
    const frames = [];
    let off = 0;
    do {
      const n = Math.min(PAY, bytes.length - off), last = off + n >= bytes.length;
      const f = new Uint8Array(n + 1);
      f[0] = type | (last ? 0x80 : 0);
      f.set(bytes.subarray(off, off + n), 1);
      frames.push(f);
      off += n;
    } while (off < bytes.length);
    let i = 0;
    const pump = () => {
      for (let k = 0; k < 8 && i < frames.length; k++, i++) {
        if (!dev.gatt.connected || !chr.notifying) return;
        const e = new Event('characteristicvaluechanged');
        chr.value = new DataView(frames[i].buffer);
        Object.defineProperty(e, 'target', { value: chr });
        chr.dispatchEvent(e);
      }
      if (i < frames.length) setTimeout(pump, 2);
    };
    pump();
  }
  const sendJson = (chr, o) => sendFramed(chr, 1, new TextEncoder().encode(JSON.stringify(o)));

  async function handle(text) {
    const [name, q = ''] = text.split('?');
    const call = (path, method) => demoFetch(path + (method === 'GET' && q ? '?' + q : ''),
      method === 'POST' ? { method: 'POST', body: q } : undefined);
    let r;
    switch (name) {
      case 'status': r = await call('/api/status', 'GET'); break;
      case 'settings': r = await call('/api/settings', 'GET'); break;
      case 'set': r = await call('/api/settings', 'POST'); break;
      case 'arm': r = await call('/api/arm', 'POST'); break;
      case 'stop': r = await call('/api/stop', 'POST'); break;
      case 'mark': r = await call('/api/mark', 'POST'); break;
      case 'runs': r = await call('/api/runs', 'GET'); break;
      case 'del': r = await call('/api/delete', 'POST'); break;
      case 'get': r = await call('/api/run', 'GET'); break;
      case 'ota': {
        const p = new URLSearchParams(q);
        Object.assign(ota, { active: true, size: +p.get('size'), sha: p.get('sha'), buf: [], queued: 0, written: 0, parts: [] });
        sendJson(chrs[RESP], { ok: true, mtu: MTU, window: 8192 }); return;
      }
      case 'otacancel': ota.active = false; sendJson(chrs[RESP], { ok: true }); return;
      case 'wifi': wifi = new URLSearchParams(q).get('on') === '1'; sendJson(chrs[RESP], { ok: true, restarting: true }); return;
      default: sendJson(chrs[RESP], { ok: false, err: 'unknown command' }); return;
    }
    if ((r.headers.get('content-type') || '').includes('json')) sendJson(chrs[RESP], await r.json());
    else sendFramed(chrs[RESP], 2, new Uint8Array(await r.arrayBuffer()));
  }

  const dev = new EventTarget();
  dev.name = 'BMX-Logger';
  dev.gatt = {
    connected: false,
    async connect() { await new Promise(r => setTimeout(r, 50)); this.connected = true; return this; },
    async getPrimaryService(u) {
      if (u !== SVC) throw new Error('No service');
      return { getCharacteristic: async c => chrs[c] };
    },
    disconnect() { this.connected = false; dev.dispatchEvent(new Event('gattserverdisconnected')); }
  };
  setInterval(async () => {
    if (!dev.gatt.connected || !chrs[STAT].notifying) return;
    const s = await (await demoFetch('/api/status')).json();
    s.wifi = wifi;
    if (!window.__fakeNoOta) { s.fw = window.__fakeFw; s.ota = ota.active; }
    sendJson(chrs[STAT], s);
  }, 500);

  window.__fakeDevice = dev;
  Object.defineProperty(navigator, 'bluetooth', { value: {
    async requestDevice(opts) {
      if (!opts.filters.some(f => (f.services || []).includes(SVC))) throw new Error('filter mismatch');
      return dev;
    }
  }});
})();
