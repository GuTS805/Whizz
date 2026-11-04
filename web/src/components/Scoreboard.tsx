"use client";

import { useEffect, useState } from "react";
import { createPublicClient, formatEther, http } from "viem";
import { mainnet } from "viem/chains";

import { explorerTx, publicClient } from "@/lib/chain";
import { useWhizzEvents } from "@/lib/events";
import { mon } from "@/lib/format";
import { summarize, useStats } from "@/lib/stats";

/**
 * THE MONAD SCOREBOARD — proof, not claims.
 * Every number is measured from this phone's real transactions:
 *  - latency = tap → confirmed receipt
 *  - Monad fee = gas LIMIT × gas price (Monad bills the limit)
 *  - Ethereum comparison = the same gas USED × Ethereum's live gas price
 */
const ethClient = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });

export function Scoreboard() {
  const { txs, pending, networkEvents } = useStats();
  const [open, setOpen] = useState(false);
  const [ethGasPrice, setEthGasPrice] = useState<bigint | null>(null);
  const s = summarize(txs);

  // Keep the shared event poller alive so "network events" counts everyone's activity.
  useWhizzEvents(() => {});

  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [monadBlockMs, setMonadBlockMs] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    ethClient.getGasPrice().then(setEthGasPrice).catch(() => setEthGasPrice(null));
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
      .then((r) => r.json())
      .then((j: { ethereum?: { usd?: number } }) => setEthUsd(j.ethereum?.usd ?? null))
      .catch(() => setEthUsd(null));
    // Measure Monad's real block time from the last 200 block timestamps.
    (async () => {
      const latest = await publicClient.getBlock();
      const older = await publicClient.getBlock({ blockNumber: latest.number - 200n });
      setMonadBlockMs(Math.round((Number(latest.timestamp - older.timestamp) * 1000) / 200));
    })().catch(() => setMonadBlockMs(null));
  }, [open]);

  const gasUsed = txs.reduce((sum, t) => sum + t.gasUsed, 0n);
  const ethCost = ethGasPrice !== null ? gasUsed * ethGasPrice : null;
  const ethCostUsd = ethCost !== null && ethUsd !== null ? Number(formatEther(ethCost)) * ethUsd : null;

  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-full bg-whizz/20 px-3 py-1.5 text-xs font-semibold text-whizz">
        ⚡ {s ? `${s.count} tx · ${s.avgMs}ms` : "0 tx"}
        {pending > 0 && <span className="ml-1 animate-pulse">· {pending}⏳</span>}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/95 p-6 pt-safe-6 text-white" onClick={() => setOpen(false)}>
          <div className="mx-auto max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-2xl font-black text-whizz">Monad Scoreboard</h2>
              <button onClick={() => setOpen(false)} className="text-2xl">✕</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat label="Your transactions" value={s ? `${s.count}` : "0"} />
              <Stat label="Avg tap → confirmed" value={s ? `${s.avgMs} ms` : "—"} />
              <Stat label="Fastest" value={s ? `${s.minMs} ms` : "—"} />
              <Stat label="Live Whizz events (everyone)" value={`${networkEvents}`} />
            </div>

            {/* Speed: like-for-like block times. */}
            <div className="mt-4 rounded-2xl bg-white/5 p-4 text-sm">
              <div className="mb-2 text-xs font-semibold text-white/60">Block time</div>
              <Bar label="Monad (measured now)" ms={monadBlockMs} max={12_000} highlight />
              <Bar label="Ethereum (fixed 12s slot)" ms={12_000} max={12_000} />
              {monadBlockMs && (
                <p className="mt-2 text-center text-lg font-black text-whizz">
                  {Math.round(12_000 / monadBlockMs)}× faster blocks
                </p>
              )}
            </div>

            {/* Cost: your exact gas, priced on Ethereum mainnet right now. */}
            <div className="mt-3 rounded-2xl bg-white/5 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-white/60">Your {s?.count ?? 0} txs on Ethereum now</span>
                <span className="font-bold">
                  {ethCostUsd !== null
                    ? `$${ethCostUsd.toFixed(2)}`
                    : ethCost !== null
                      ? `${Number(formatEther(ethCost)).toPrecision(3)} ETH`
                      : "…"}
                </span>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-white/60">Paid here (testnet MON)</span>
                <span className="font-bold">{s ? `${mon(s.totalFee, 6)} MON` : "—"}</span>
              </div>
              <p className="mt-2 text-[11px] text-white/40">
                {gasUsed.toString()} gas used × live Ethereum gas price
                {ethGasPrice !== null && ` (${(Number(ethGasPrice) / 1e9).toFixed(2)} gwei)`}
                {ethUsd !== null && ` × ETH $${Math.round(ethUsd)}`}.
              </p>
            </div>

            <h3 className="mt-5 mb-2 text-sm font-semibold text-white/60">Recent transactions</h3>
            <ul className="space-y-1 text-xs">
              {[...txs].reverse().slice(0, 25).map((t) => (
                <li key={t.hash} className="flex justify-between rounded-lg bg-white/5 px-3 py-2">
                  <a href={explorerTx(t.hash)} target="_blank" rel="noreferrer" className="text-whizz underline">
                    {t.label}
                  </a>
                  <span className="text-white/60">block {t.block.toString()}</span>
                  <span className="font-mono">{t.latencyMs} ms</span>
                </li>
              ))}
              {txs.length === 0 && <li className="text-white/40">Send a snap to start the clock ⏱️</li>}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

function Bar({ label, ms, max, highlight }: { label: string; ms: number | null; max: number; highlight?: boolean }) {
  const pct = ms === null ? 0 : Math.max(1.5, (ms / max) * 100);
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs">
        <span className={highlight ? "text-whizz" : "text-white/60"}>{label}</span>
        <span className="font-mono">{ms === null ? "…" : ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full ${highlight ? "bg-whizz" : "bg-white/40"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white/5 p-4">
      <div className="text-2xl font-black">{value}</div>
      <div className="text-[11px] text-white/50">{label}</div>
    </div>
  );
}
