import { formatEther } from "viem";

/** 1234500000000000000n → "1.2345" (max 4 decimals, no trailing zeros). */
export function mon(wei: bigint, decimals = 4): string {
  const [whole, frac = ""] = formatEther(wei).split(".");
  const trimmed = frac.slice(0, decimals).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function timeLeft(expiresAt: number, nowSec: number): string {
  const s = Math.max(0, expiresAt - nowSec);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
