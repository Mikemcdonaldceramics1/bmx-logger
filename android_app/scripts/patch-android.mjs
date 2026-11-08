// Run after `npx cap add android`: Bluetooth permissions, version number, icons and splash.
import { readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = join(app, 'android', 'app', 'src', 'main');

// 1. Manifest: Bluetooth scan without location permission on Android 12+ (as the plugin documents)
const manifestPath = join(main, 'AndroidManifest.xml');
let m = readFileSync(manifestPath, 'utf8');
if (!m.includes('xmlns:tools=')) {
  m = m.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools"');
}
const perms = `
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_SCAN"
        android:usesPermissionFlags="neverForLocation"
        tools:targetApi="s" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
`;
const internet = '<uses-permission android:name="android.permission.INTERNET" />';
if (!m.includes(internet)) throw new Error('AndroidManifest.xml: INTERNET permission line not found');
if (!m.includes('BLUETOOTH_SCAN')) m = m.replace(internet, internet + perms);
writeFileSync(manifestPath, m);

// 2. Version: build number from GitHub Actions, so each new APK installs over the last one
const gradlePath = join(app, 'android', 'app', 'build.gradle');
const run = parseInt(process.env.GITHUB_RUN_NUMBER || '1', 10);
let g = readFileSync(gradlePath, 'utf8');
g = g.replace(/versionCode \d+/, `versionCode ${run}`).replace(/versionName "[^"]*"/, `versionName "1.0.${run}"`);

// 2b. Sign every build with the key saved in the repository (android_app/keystore/debug.keystore).
// Without this, the build tool makes a new key each time and Android refuses to install updates.
const ks = join(app, 'keystore', 'debug.keystore');
if (!existsSync(ks)) throw new Error(`signing key missing: ${ks}`);
if (!g.includes('signingConfigs')) {
  const sign = `
    signingConfigs {
        bmx {
            storeFile file(${JSON.stringify(ks)})
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.bmx
        }`;
  if (!g.includes('    buildTypes {')) throw new Error('app/build.gradle: buildTypes block not found');
  g = g.replace('    buildTypes {', sign);
}
writeFileSync(gradlePath, g);

// 3. Icons and splash: copy our images over the template's, and drop the adaptive icon so ours is used
const res = join(main, 'res');
cpSync(join(app, 'resources', 'res'), res, { recursive: true });
const adaptive = join(res, 'mipmap-anydpi-v26');
if (existsSync(adaptive)) rmSync(adaptive, { recursive: true });

console.log(`Android project patched: Bluetooth permissions, version 1.0.${run}, fixed signing key, icons and splash`);
