# Whizz

Snap money to your friends — built on Monad.

Every action is a real on-chain transaction: sending a snap, each tick of
hold-to-unwrap, emoji reactions and catching a Whizz Rain drop.

## Structure

| Folder       | What                                                     |
| ------------ | -------------------------------------------------------- |
| `contracts/` | `Whizz.sol` escrow contract, tests, deploy scripts       |
| `web/`       | Next.js mobile web app (burner wallet, camera, scoreboard) |

## Run it

```bash
# 1. Contracts — test, then deploy to Monad testnet
cd contracts
npm install
npm test
npx hardhat keystore set MONAD_PRIVATE_KEY   # funded testnet wallet
npm run deploy:testnet                        # writes web/src/lib/deployment.json

# 2. Web app
cd ../web
npm install
cp .env.example .env.local                    # add FAUCET_PRIVATE_KEY
npm run dev
```

Phones only allow camera access over https — deploy `web/` to Vercel (or
use `npx next dev --experimental-https`) to test on a phone.

After changing the contract, run `npm run export-abi` in `contracts/` to
refresh the web app's ABI.
