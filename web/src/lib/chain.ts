import { createPublicClient, defineChain, http } from "viem";

import deployment from "./deployment.json";

/** Monad testnet. RPC URL can be overridden (e.g. a faster private RPC) via env. */
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" },
  },
  testnet: true,
});

/**
 * Read-only client. `pollingInterval` is how often we ask the chain for new
 * events/receipts — Monad makes a block every ~400ms, so we poll faster than
 * that to show every block as it lands.
 */
export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(undefined, { batch: true }),
  pollingInterval: 250,
});

export const WHIZZ_ADDRESS = deployment.address as `0x${string}` | null;
export const DEPLOY_BLOCK = BigInt(deployment.deployBlock);

export const explorerTx = (hash: string) => `${monadTestnet.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (addr: string) => `${monadTestnet.blockExplorers.default.url}/address/${addr}`;
