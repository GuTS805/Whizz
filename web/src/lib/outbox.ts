"use client";

import { useSyncExternalStore } from "react";
import type { Address } from "viem";

import { friendlyError } from "./tx";

/**
 * Snaps that are on their way. Tapping Send drops the snap in here and jumps
 * straight to the chat (like Snapchat) — the chat shows it as "Sending ⚡"
 * until Monad confirms it, or "Not sent" with a Retry button.
 *
 * It lives outside React components on purpose: the camera screen unmounts
 * the moment you hit Send, but the send must keep going.
 */
export type OutgoingSnap = {
  id: number;
  to: Address;
  amount: bigint;
  status: "sending" | "sent" | "failed";
  error?: string;
};

type Job = { snap: OutgoingSnap; run: () => Promise<unknown> };

let items: OutgoingSnap[] = [];
const jobs = new Map<number, Job["run"]>();
const listeners = new Set<() => void>();
let nextId = 0;

function update(id: number, patch: Partial<OutgoingSnap>) {
  items = items.map((s) => (s.id === id ? { ...s, ...patch } : s));
  listeners.forEach((l) => l());
}

async function start(id: number) {
  const run = jobs.get(id);
  if (!run) return;
  update(id, { status: "sending", error: undefined });
  try {
    await run();
    jobs.delete(id);
    update(id, { status: "sent" });
  } catch (e) {
    update(id, { status: "failed", error: friendlyError(e) });
  }
}

export const outbox = {
  /** Queue a snap and start sending it right away. */
  send(to: Address, amount: bigint, run: () => Promise<unknown>) {
    const id = ++nextId;
    jobs.set(id, run);
    items = [...items, { id, to, amount, status: "sending" }];
    listeners.forEach((l) => l());
    void start(id);
  },
  retry: (id: number) => void start(id),
  remove(id: number) {
    jobs.delete(id);
    items = items.filter((s) => s.id !== id);
    listeners.forEach((l) => l());
  },
};

export function useOutbox(): OutgoingSnap[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => items,
    () => items,
  );
}
