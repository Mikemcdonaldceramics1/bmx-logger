// Native pieces for the Android app. esbuild bundles this into www/native.js, which the app page
// loads before its own scripts. The page checks for window.BmxNative to use native Bluetooth.
import { BleClient } from '@capacitor-community/bluetooth-le';
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

window.BmxNative = { BleClient, Filesystem, Share };
