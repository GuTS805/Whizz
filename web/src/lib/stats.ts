"use client";

import { useSyncExternalStore } from "react";

/**
 * Live scoreboard data — the "why Monad" proof shown on screen.
 * Every number here is MEASURED from real transactions, never hard-coded.
 */
export type TxRecord = {
  hash: `0x${string}`;
  label: string;
  latencyMs: number; // tap → receipt confirmed
  gasUsed: bigint;
  gasLimit: bigint; // Monad charges gas LIMIT, so this is what we pay for
  gasPrice: bigint;
  block: bigint;
};

type Stats = {
  txs: TxRecord[];
  pending: number;
  /** Whizz events seen from everyone (not just this phone). */
  networkEvents: number;
};

let state: Stats = { txs: [], pending: 0, networkEvents: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<Stats>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export const statsStore = {
  addPending: () => set({ pending: state.pending + 1 }),
  resolvePending: (rec?: TxRecord) =>
    set({ pending: Math.max(0, state.pending - 1), txs: rec ? [...state.txs, rec] : state.txs }),
  addNetworkEvents: (n: number) => set({ networkEvents: state.networkEvents + n }),
};

export function useStats(): Stats {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

export function summarize(txs: TxRecord[]) {
  if (txs.length === 0) return null;
  const lat = txs.map((t) => t.latencyMs).sort((a, b) => a - b);
  const totalFee = txs.reduce((s, t) => s + t.gasLimit * t.gasPrice, 0n);
  const totalGas = txs.reduce((s, t) => s + t.gasLimit, 0n);
  return {
    count: txs.length,
    avgMs: Math.round(lat.reduce((s, x) => s + x, 0) / lat.length),
    p50Ms: lat[Math.floor(lat.length / 2)],
    minMs: lat[0],
    totalFee,
    totalGas,
  };
}
