import { isAddress, keccak256, nonceManager, parseEther, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { monadTestnet, publicClient } from "@/lib/chain";

/**
 * Gas drip: new burner wallets start with 0 MON and can't pay gas.
 * This server route sends them a little MON from a funded "faucet" wallet,
 * so a judge can scan the QR and start snapping without touching a faucet.
 *
 * The faucet key lives ONLY on the server (env var without NEXT_PUBLIC_),
 * so it's never shipped to browsers.
 *
 * Built for a whole room scanning a QR at once:
 *  - a local nonce counter, so 30 parallel drips get nonces n, n+1, n+2…
 *    instead of all fetching (and colliding on) the same one
 *  - retry with a fresh nonce if another server instance used ours
 */
const DRIP = parseEther(process.env.DRIP_AMOUNT ?? "0.1");
const TOP_UP_BELOW = DRIP / 2n; // only drip wallets that are actually low
const COOLDOWN_MS = 10 * 60_000; // one drip per address per 10 minutes
const TRANSFER_GAS = 21_000n; // a plain MON transfer always costs exactly this (Monad bills the limit)

const lastDrip = new Map<string, number>();
let faucet: PrivateKeyAccount | null = null;

function getFaucet(): PrivateKeyAccount | null {
  if (faucet) return faucet;
  const raw = process.env.FAUCET_PRIVATE_KEY?.trim();
  if (!raw) return null;
  // MetaMask exports keys without "0x" — accept both forms.
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  faucet = privateKeyToAccount(key, { nonceManager });
  return faucet;
}

const isNonceClash = (e: unknown) => /nonce|already known|replacement/i.test(String((e as Error)?.message ?? e));
const isRateLimited = (e: unknown) => /429|rate limit/i.test(String((e as Error)?.message ?? e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Gas price changes slowly — cache it so each drip saves a round trip.
let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; at: number } | null = null;
async function getFees() {
  if (!fees || Date.now() - fees.at > 15_000) {
    const f = await publicClient.estimateFeesPerGas();
    fees = { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, at: Date.now() };
  }
  return fees;
}

/** Send a signed tx; on HTTP 429 (rejected before processing) resend the SAME tx after a pause. */
async function sendWithBackoff(serializedTransaction: `0x${string}`) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await publicClient.sendRawTransactionSync({ serializedTransaction, timeout: 15_000 });
    } catch (err) {
      if (isRateLimited(err) && attempt < 6) {
        await sleep(300 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      throw err;
    }
  }
}

async function sendDrip(account: PrivateKeyAccount, to: `0x${string}`) {
  const { maxFeePerGas, maxPriorityFeePerGas } = await getFees();
  for (let attempt = 0; ; attempt++) {
    const nonce = await account.nonceManager!.consume({ address: account.address, chainId: monadTestnet.id, client: publicClient });
    const serializedTransaction = await account.signTransaction({
      chainId: monadTestnet.id,
      type: "eip1559",
      to,
      value: DRIP,
      gas: TRANSFER_GAS,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    try {
      // One call: Monad sends the tx and returns its receipt (EIP-7966).
      const receipt = await sendWithBackoff(serializedTransaction);
      return receipt.transactionHash;
    } catch (err) {
      account.nonceManager!.reset({ address: account.address, chainId: monadTestnet.id });
      if (isNonceClash(err) && attempt < 3) continue;
      // Sync call may have broadcast before failing — check before giving up.
      const hash = keccak256(serializedTransaction);
      const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt?.status === "success") return hash;
      throw err;
    }
  }
}

export async function POST(request: Request) {
  const account = getFaucet();
  if (!account) return Response.json({ error: "Faucet not configured" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { address?: string } | null;
  const address = body?.address;
  if (!address || !isAddress(address)) return Response.json({ error: "Bad address" }, { status: 400 });

  const now = Date.now();
  const id = address.toLowerCase();
  if (now - (lastDrip.get(id) ?? 0) < COOLDOWN_MS) {
    return Response.json({ error: "Already dripped recently — try again in a few minutes" }, { status: 429 });
  }

  const balance = await publicClient.getBalance({ address });
  if (balance >= TOP_UP_BELOW) return Response.json({ ok: true, skipped: true, balance: balance.toString() });

  lastDrip.set(id, now);
  try {
    const hash = await sendDrip(account, address);
    return Response.json({ ok: true, hash });
  } catch (err) {
    lastDrip.delete(id); // let them retry if the send failed
    console.error("drip failed", err);
    return Response.json({ error: "Faucet send failed — is the faucet wallet funded?" }, { status: 500 });
  }
}
