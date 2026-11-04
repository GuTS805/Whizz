# Whizz ⚡

**Snap money to your friends — every snap settles on Monad.**

Whizz is a Snapchat-style app where money behaves like a snap: attach MON to a
photo, your friend *holds to unwrap* it block by block, and if they never open
it — poof — it goes back to you.

| | |
| --- | --- |
| 🌐 **Live app** | https://whizz-pink.vercel.app |
| 📜 **Contract** | [`0x0f332f5a174f31c6c072844c658957212d3736d6`](https://testnet.monadexplorer.com/address/0x0f332f5a174f31c6c072844c658957212d3736d6) |
| ⛓️ **Network** | Monad Testnet (chain ID `10143`) |

## Why Monad

Most crypto apps make a few transactions per user per month. Whizz makes
**several per second** — every action is a real on-chain transaction:

- **Hold-to-unwrap** — while your finger is down, the app sends one `unwrap`
  transaction per block. The progress bar only moves when a block confirms, so
  every bump you see *is* a Monad block.
- **Snaps on-chain** — the photo travels inside the transaction (event log), no
  server or IPFS.
- **Whizz Rain** — a pot split into drops that a whole room catches at once.
- **Paid reactions** — 🔥 💀 🫶 send tiny tips that only make sense with tiny fees.
- **Live scoreboard** — measures real tap → confirmed latency and fees on screen.

This only works with fast blocks, cheap transactions and high throughput.

## Features

- 📸 Camera snaps compressed to ~5 KB and stored fully on-chain
- 💸 Attach MON to any snap; timer of 2 min, 1 h or 24 h
- 👆 Hold-to-unwrap, paid out per block
- 💨 Unopened money returns to the sender after expiry
- 🌧️ Whizz Rain with QR code for the room
- 🔐 Wallet created in the browser + gas drip — no MetaMask, no seed phrase

## Project structure

| Folder | What |
| --- | --- |
| `contracts/` | `Whizz.sol` escrow contract, 12 tests, deploy scripts (Hardhat 3) |
| `web/` | Next.js mobile web app (viem, Tailwind, Motion) |
| `mobile/` | Android app (Capacitor) — native shell around the hosted web app |

## Setup

Requirements: Node.js 22+.

```bash
# 1. Contracts — test and deploy to Monad testnet
cd contracts
npm install
npm test
cp .env.example .env          # add MONAD_PRIVATE_KEY (funded testnet wallet)
npm run deploy:testnet        # writes web/src/lib/deployment.json

# 2. Web app
cd ../web
npm install
cp .env.example .env.local    # add FAUCET_PRIVATE_KEY (pays gas for new users)
npm run dev                   # http://localhost:3000
```

Phones only allow camera access over https — use the live URL, or
`npx next dev --experimental-https` for local phone testing.

After changing the contract, run `npm run export-abi` in `contracts/` to
refresh the web app's ABI.

### Android app

The Android app loads the hosted web app inside a native shell (camera
permission, app icon, full screen), so web deploys reach the app instantly.
Requires Android Studio (SDK) and JDK 21.

```bash
cd mobile
npm install
# put the hosted https URL in whizz.config.json → { "appUrl": "https://..." }
npm run sync                  # copies config into the Android project
cd android && ./gradlew assembleDebug
# APK: mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Install on a USB-connected phone with `adb install -r app/build/outputs/apk/debug/app-debug.apk`,
or open the project in Android Studio with `npm run open`.

> On Windows PowerShell, use `npm.cmd` / `npx.cmd` if script execution is disabled.
