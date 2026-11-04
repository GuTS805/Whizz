"use client";

import { useEffect, useRef } from "react";
import { parseEventLogs, type ParseEventLogsReturnType } from "viem";

import { whizzAbi } from "./abi";
import { publicClient, WHIZZ_ADDRESS } from "./chain";
import { statsStore } from "./stats";

export type WhizzLog = ParseEventLogsReturnType<typeof whizzAbi>[number];
type Listener = (logs: WhizzLog[]) => void;

/**
 * ONE shared poller for the whole app: ask for new Whizz logs since the last
 * block we saw, then fan them out to every screen that cares (inbox, rain,
 * scoreboard). Plain getLogs works on every RPC — no filters/WebSockets.
 *
 * Built to respect the public RPC's limits (measured):
 *  - getLogs accepts at most 101 blocks per query → we never ask for more than 100
 *  - it rate-limits per IP (venue Wi-Fi = everyone shares one IP) → poll every
 *    ~2 blocks, back off on errors, and stop entirely while the tab is hidden
 */
const POLL_MS = 800;
const MAX_BACKOFF_MS = 8000;
const MAX_SPAN = 100n;

const listeners = new Set<Listener>();
let running = false;
let lastBlock: bigint | null = null;

async function loop() {
  let delay = POLL_MS;
  while (listeners.size > 0) {
    if (document.hidden) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    try {
      const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
      // First run, or we slept for a long time: start near the tip.
      // (Each screen loads its own state, so skipped history isn't lost.)
      if (lastBlock === null || latest - lastBlock > MAX_SPAN * 3n) lastBlock = latest;
      if (latest > lastBlock) {
        const fromBlock = lastBlock + 1n;
        const toBlock = latest - fromBlock >= MAX_SPAN ? fromBlock + MAX_SPAN - 1n : latest;
        const raw = await publicClient.getLogs({ address: WHIZZ_ADDRESS!, fromBlock, toBlock });
        lastBlock = toBlock;
        const logs = parseEventLogs({ abi: whizzAbi, logs: raw });
        if (logs.length) {
          statsStore.addNetworkEvents(logs.length);
          listeners.forEach((l) => l(logs));
        }
      }
      delay = POLL_MS;
    } catch {
      // Rate-limited or network hiccup — slow down, then try again.
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  running = false;
}

/** Subscribe a component to live Whizz events. */
export function useWhizzEvents(onLogs: Listener) {
  const ref = useRef(onLogs);
  useEffect(() => {
    ref.current = onLogs;
  });

  useEffect(() => {
    if (!WHIZZ_ADDRESS) return;
    const l: Listener = (logs) => ref.current(logs);
    listeners.add(l);
    if (!running) {
      running = true;
      void loop();
    }
    return () => {
      listeners.delete(l);
    };
  }, []);
}
