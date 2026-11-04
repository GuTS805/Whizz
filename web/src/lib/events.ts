"use client";

import { useEffect, useRef } from "react";
import { parseEventLogs, type ParseEventLogsReturnType } from "viem";

import { whizzAbi } from "./abi";
import { publicClient, WHIZZ_ADDRESS } from "./chain";
import { statsStore } from "./stats";

export type WhizzLog = ParseEventLogsReturnType<typeof whizzAbi>[number];
type Listener = (logs: WhizzLog[]) => void;

/**
 * ONE shared poller for the whole app: every ~400ms (≈ one Monad block) ask
 * for new Whizz logs since the last block we saw, then fan them out to every
 * screen that cares (inbox, rain, scoreboard). Plain getLogs on small ranges
 * works on every RPC — no filter or WebSocket support needed.
 */
const listeners = new Set<Listener>();
let running = false;
let lastBlock: bigint | null = null;

async function loop() {
  while (listeners.size > 0) {
    try {
      const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
      if (lastBlock === null) lastBlock = latest;
      if (latest > lastBlock) {
        const raw = await publicClient.getLogs({ address: WHIZZ_ADDRESS!, fromBlock: lastBlock + 1n, toBlock: latest });
        lastBlock = latest;
        const logs = parseEventLogs({ abi: whizzAbi, logs: raw });
        if (logs.length) {
          statsStore.addNetworkEvents(logs.length);
          listeners.forEach((l) => l(logs));
        }
      }
    } catch {
      // Network hiccup — just try again next tick.
    }
    await new Promise((r) => setTimeout(r, 400));
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
