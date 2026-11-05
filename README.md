# BMX Logger

ESP32 + motion sensor + wheel and crank magnet sensors. Records how fast each gearing gets a BMX
rider moving, and an Android app arms runs and compares them over Bluetooth.

## Get the Android app

Every push to `main` builds the app. Open **Releases** (right side of the repository page) on the
phone, tap the newest **bmx-logger.apk**, and install it. The first time, Android asks to allow
installs from your browser: allow it, then go back and install. Later builds install over the old
one and keep your settings.

The build runs in the **Actions** tab (about 5 minutes). If a build fails, its log is there.

## Repository layout

| Path | What it is |
| --- | --- |
| `index.html` | The phone app (screens, charts, analysis). The APK is built from this file. |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | Lets `index.html` also run as a web app in Chrome (GitHub Pages, optional). |
| `android_app/` | Wraps `index.html` as an Android app with Capacitor and native Bluetooth. |
| `.github/workflows/build-apk.yml` | Builds the APK and publishes it as a release. |
| `firmware/bmx_logger/` | ESP32 Arduino sketch. `firmware/bmx_logger_merged.bin` is ready to flash at 0x0. |
| `tools/` | Simulated runs, analysis test, Bluetooth protocol test, fake Bluetooth logger. |

To change the app, edit `index.html` and push: a new APK is built automatically.

## Flash the logger

Open https://espressif.github.io/esptool-js/ in Chrome or Edge on a computer, connect the ESP32,
flash `firmware/bmx_logger_merged.bin` at address 0x0. Re-flashing erases stored runs.

From Arduino IDE instead: install "esp32 by Espressif" 3.x and the "NimBLE-Arduino" library by
h2zero (tested 2.5.1), pick "ESP32 Dev Module", open `firmware/bmx_logger/bmx_logger.ino`, Upload.
Keep `partitions.csv` and `ble_proto.h` next to the `.ino`.

## Use it

1. Power the logger. Its LED blips every 2 s while it waits for a phone.
2. Open the app, tap **Connect**, pick **BMX-Logger**, and allow Nearby devices. After the first
   time the app connects by itself when it opens. The LED pulses slowly while connected.
3. Settings: wheel circumference, magnet counts, forward axis. Save.
4. Record: arm, hold the bike still 1 s, ride. Runs: tick runs, **Analyze selected**.
   **Save** on a run opens the share sheet (Drive, email, Files).

## Versions

App: Capacitor 8.5.3, @capacitor-community/bluetooth-le 8.3.0, @capacitor/filesystem 8.1.5,
@capacitor/share 8.0.3, built with Node 22 and Java 21. Firmware: ESP32 Arduino core 3.3.12,
NimBLE-Arduino 2.5.1.

The app's signing key is created by the first build and saved in `android_app/keystore/`. It only
lets new builds install over old ones; keep the repository as it is so updates keep working.
