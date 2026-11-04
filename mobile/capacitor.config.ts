import { readFileSync } from "node:fs";
import path from "node:path";

import type { CapacitorConfig } from "@capacitor/cli";

// The Android app is a native shell around the hosted Whizz web app, so every
// fix we deploy shows up in the app instantly — no APK rebuild needed.
// Set the hosted https URL in whizz.config.json, then run `npm run sync`.
//
// USB testing without hosting: use "http://localhost:3000" and run
// `adb reverse tcp:3000 tcp:3000` — the phone's localhost then reaches the
// laptop's dev server. Android treats localhost as secure, so the camera works.
const { appUrl } = JSON.parse(readFileSync(path.join(__dirname, "whizz.config.json"), "utf8")) as {
  appUrl: string;
};
const isLocalDev = /^http:\/\/localhost(:\d+)?\/?$/.test(appUrl);
const configured = (/^https:\/\//.test(appUrl) && !appUrl.includes("REPLACE-WITH")) || isLocalDev;
if (!configured) {
  console.warn("⚠️  mobile/whizz.config.json has no app URL yet — the APK will show a setup screen.");
} else if (isLocalDev) {
  console.warn("⚠️  USB dev mode: loading http://localhost — run `adb reverse tcp:3000 tcp:3000`. Not for release.");
}

const config: CapacitorConfig = {
  appId: "xyz.whizz.app",
  appName: "Whizz",
  webDir: "www",
  backgroundColor: "#000000",
  server: configured
    ? {
        url: appUrl,
        // Plain http is only ever allowed for the localhost USB dev mode.
        cleartext: isLocalDev,
        // Shown if the app can't reach the server (offline, etc.).
        errorPath: "offline.html",
      }
    : undefined,
  android: {
    backgroundColor: "#000000",
  },
  plugins: {
    SystemBars: {
      // Light status-bar icons on our black UI; safe-area sizes are injected
      // into the page as --safe-area-inset-* CSS variables.
      style: "DARK",
      insetsHandling: "css",
    },
  },
};

export default config;
