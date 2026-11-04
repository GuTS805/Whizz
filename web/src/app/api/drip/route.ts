import { createWalletClient, http, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { monadTestnet, publicClient } from "@/lib/chain";

/**
 * Gas drip: new burner wallets start with 0 MON and can't pay gas.
 * This server route sends them a little MON from a funded "faucet" wallet,
 * so a judge can scan the QR and start snapping without touching a faucet.
 *
 * The faucet key lives ONLY on the server (env var without NEXT_PUBLIC_),
 * so it's never shipped to browsers.
 */
const DRIP = parseEther(process.env.DRIP_AMOUNT ?? "0.1");
const TOP_UP_BELOW = DRIP / 2n; // only drip wallets that are actually low
const COOLDOWN_MS = 10 * 60_000; // one drip per address per 10 minutes

const lastDrip = new Map<string, number>();

export async function POST(request: Request) {
  const key = process.env.FAUCET_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) return Response.json({ error: "Faucet not configured" }, { status: 503 });

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
    const faucet = createWalletClient({ account: privateKeyToAccount(key), chain: monadTestnet, transport: http() });
    const hash = await faucet.sendTransaction({ to: address, value: DRIP });
    await publicClient.waitForTransactionReceipt({ hash });
    return Response.json({ ok: true, hash });
  } catch (err) {
    lastDrip.delete(id); // let them retry if the send failed
    console.error("drip failed", err);
    return Response.json({ error: "Faucet send failed — is the faucet wallet funded?" }, { status: 500 });
  }
}
