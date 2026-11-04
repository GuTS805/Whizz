# Whizz ⚡

[![CI](https://github.com/GuTS805/Whizz/actions/workflows/ci.yml/badge.svg)](https://github.com/GuTS805/Whizz/actions/workflows/ci.yml)

**Snap money to your friends — every snap settles on Monad.**

Whizz is a Snapchat-style app where money behaves like a snap: attach MON to a
photo, your friend *holds to unwrap* it block by block, and if they never open
it — poof — it goes back to you.

| | |
| --- | --- |
| 🌐 **Live app** | https://whizz-pink.vercel.app |
| 📜 **Contract** | [`0x97fbebffcb6e3ab5aeb68c65c68e52a6051b3415`](https://testnet.monadexplorer.com/address/0x97fbebffcb6e3ab5aeb68c65c68e52a6051b3415) |
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
| `contracts/` | `Whizz.sol` escrow contract, full test suite, deploy scripts (Hardhat 3) |
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
npm run build:apk             # debug APK (Windows, macOS and Linux)
npm run build:apk -- release  # signed release APK (needs android/keystore.properties)
```

APKs land in `mobile/android/app/build/outputs/apk/`. Install on a USB-connected
phone with `adb install -r <apk>`, or open the project in Android Studio with `npm run open`.

Release builds are signed with `android/whizz-release.jks`, configured in
`android/keystore.properties` (both git-ignored — back them up; without them you
can't ship updates). A release build refuses to run if the app URL is still the
localhost USB dev mode.

> On Windows PowerShell, use `npm.cmd` / `npx.cmd` if script execution is disabled.
