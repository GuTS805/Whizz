import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { createRequire } from "node:module";
import { configVariable, defineConfig } from "hardhat/config";

// Use the solc compiler bundled in the `solc` npm package instead of
// downloading it — binaries.soliditylang.org is flaky on some networks.
const solcPath = createRequire(import.meta.url).resolve("solc/soljson.js");

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
        path: solcPath,
        settings: {
          // Optimizer = smaller, cheaper bytecode. Matters on Monad because
          // users pay for every snap, unwrap tick and reaction.
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
        },
      },
    },
  },
  networks: {
    // Local simulated chain used by `npx hardhat test`.
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    // Monad testnet. The key is read from the MONAD_PRIVATE_KEY env var
    // (or Hardhat's encrypted keystore) — never hard-coded or committed.
    monadTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 10143,
      url: "https://testnet-rpc.monad.xyz",
      accounts: [configVariable("MONAD_PRIVATE_KEY")],
    },
  },
});
