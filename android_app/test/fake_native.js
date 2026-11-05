/* Test double for the Android app's native layer: window.Capacitor plus window.BmxNative with a
   BleClient that follows the @capacitor-community/bluetooth-le API. Underneath it uses the fake
   logger from tools/fake_bluetooth.js (same framed protocol as the firmware). Load that first. */
(() => {
  const SVC = '6e7a0001-3b2c-4d1a-9f5e-8b6c4d2a1f00';
  window.Capacitor = { isNativePlatform: () => true };
  const calls = [];
  let dev = null, svc = null;
  const getDev = async () => dev || (dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }] }));
  const BleClient = {
    async initialize(o) { calls.push('initialize:' + !!(o && o.androidNeverForLocation)); },
    async isEnabled() { return true; },
    async requestEnable() {},
    async requestDevice(o) { calls.push('requestDevice'); await getDev(); return { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'BMX-Logger' }; },
    async connect(id, onDisconnect) {
      calls.push('connect:' + id);
      const d = await getDev();
      d.addEventListener('gattserverdisconnected', () => onDisconnect && onDisconnect(id), { once: true });
      await d.gatt.connect();
      svc = await d.gatt.getPrimaryService(SVC);
    },
    async requestConnectionPriority(id, p) { calls.push('priority:' + p); },
    async startNotifications(id, s, chr, cb) {
      const c = await svc.getCharacteristic(chr);
      if (c.__nativeListener) c.removeEventListener('characteristicvaluechanged', c.__nativeListener);  // plugin replaces old listener
      c.__nativeListener = e => cb(e.target.value);
      c.addEventListener('characteristicvaluechanged', c.__nativeListener);
      await c.startNotifications();
    },
    async write(id, s, chr, dv) {
      if (!(dv instanceof DataView)) throw new Error('write expects a DataView');
      const c = await svc.getCharacteristic(chr);
      await c.writeValueWithResponse(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    }
  };
  window.__nativeCalls = calls;
  window.BmxNative = {
    BleClient,
    Filesystem: { async writeFile(o) { window.__saved = o; return { uri: 'file:///data/cache/' + o.path }; } },
    Share: { async share(o) { window.__shared = o; } }
  };
})();
