"use client";

import { getAbiItem, keccak256, toBytes, type Address, type Hex } from "viem";

import { whizzAbi } from "./abi";
import { publicClient, WHIZZ_ADDRESS } from "./chain";

/** Read helpers — free (no gas), they just ask an RPC node for contract state. */

export type SnapView = {
  id: bigint;
  from: Address;
  to: Address;
  expiresAt: number; // unix seconds
  sentBlock: bigint;
  total: bigint;
  claimed: bigint;
};

export type RainView = {
  id: bigint;
  from: Address;
  expiresAt: number;
  drops: number;
  perDrop: bigint;
  caught: number;
  ended: boolean;
};

const ZERO = "0x0000000000000000000000000000000000000000";
const base = () => ({ address: WHIZZ_ADDRESS!, abi: whizzAbi }) as const;

export async function addressForName(name: string): Promise<Address | null> {
  const addr = await publicClient.readContract({
    ...base(),
    functionName: "ownerOfName",
    args: [keccak256(toBytes(name.toLowerCase().replace(/^@/, "")))],
  });
  return addr === ZERO ? null : addr;
}

const nameCache = new Map<Address, string>();
export async function nameOf(addr: Address): Promise<string> {
  const hit = nameCache.get(addr);
  if (hit) return hit;
  const name = await publicClient.readContract({ ...base(), functionName: "nameOf", args: [addr] });
  if (name) nameCache.set(addr, name);
  return name || `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export async function getSnap(id: bigint): Promise<SnapView> {
  const [from, expiresAt, to, sentBlock, total, claimed] = await publicClient.readContract({
    ...base(),
    functionName: "snaps",
    args: [id],
  });
  return { id, from, to, expiresAt: Number(expiresAt), sentBlock, total, claimed };
}

export async function getRain(id: bigint): Promise<RainView> {
  const [from, expiresAt, drops, perDrop, caught, ended] = await publicClient.readContract({
    ...base(),
    functionName: "rains",
    args: [id],
  });
  return { id, from, expiresAt: Number(expiresAt), drops, perDrop, caught, ended };
}

/** Latest `limit` snap ids for a user, newest first. */
export async function listSnapIds(user: Address, box: "inbox" | "outbox", limit = 20n): Promise<bigint[]> {
  const len = await publicClient.readContract({
    ...base(),
    functionName: box === "inbox" ? "inboxLength" : "outboxLength",
    args: [user],
  });
  const offset = len > limit ? len - limit : 0n;
  const ids = await publicClient.readContract({ ...base(), functionName: box, args: [user, offset, limit] });
  return [...ids].reverse();
}

const snapSentEvent = getAbiItem({ abi: whizzAbi, name: "SnapSent" });

/**
 * The photo isn't in contract storage (too expensive) — it's in the SnapSent
 * event log. We stored the block number, so we fetch logs from exactly that
 * one block, filtered by snap id. Cheap and needs no indexer.
 */
export async function getSnapContent(snap: SnapView): Promise<{ caption: string; image: Hex }> {
  const logs = await publicClient.getLogs({
    address: WHIZZ_ADDRESS!,
    event: snapSentEvent,
    args: { id: snap.id },
    fromBlock: snap.sentBlock,
    toBlock: snap.sentBlock,
    strict: true,
  });
  const log = logs[0];
  return { caption: log?.args.caption ?? "", image: log?.args.image ?? "0x" };
}
