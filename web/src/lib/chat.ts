"use client";

import { concat, getAbiItem, hexToBytes, keccak256, type Address, type Hex } from "viem";

import { whizzAbi } from "./abi";
import { publicClient, WHIZZ_ADDRESS } from "./chain";
import { decryptMessage } from "./crypto";
import { exportPrivateKey } from "./wallet";
import { getSnap, nameOf, type SnapView } from "./whizz";

/**
 * Chat data. On-chain, each conversation is an ordered list of items
 * (text messages and snaps). Message text lives in MessageSent events, so we
 * fetch logs only for the blocks the items point to — grouped into ranges the
 * public RPC accepts (≤ 100 blocks per getLogs).
 */
export const MAX_MESSAGE_TEXT_BYTES = 900; // encrypted twice + headers stays under the contract's 2048

export type ChatEntry =
  | { kind: "message"; index: number; from: Address; text: string; block: bigint }
  | { kind: "snap"; index: number; from: Address; snap: SnapView; block: bigint };

export type ChatSummary = {
  partner: Address;
  name: string;
  length: number;
  lastBlock: bigint;
  /** Unix seconds of the last item (from its block). */
  lastTime: number;
  preview: string;
  lastFromMe: boolean;
  lastKind: "message" | "snap";
  /** For a snap: does it carry money, and has the recipient opened it? */
  snapMoney: boolean;
  snapOpened: boolean;
};

const base = () => ({ address: WHIZZ_ADDRESS!, abi: whizzAbi }) as const;
const messageEvent = getAbiItem({ abi: whizzAbi, name: "MessageSent" });
const MAX_SPAN = 100n;

/**
 * Same formula as the contract's chatId(a, b): keccak256 of the two addresses,
 * lower one first. Computed here instead of asked for — one round trip saved
 * every time a chat opens.
 */
export function getChatId(a: Address, b: Address): Hex {
  const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(concat([lo, hi]));
}

/** Fetch MessageSent logs for a chat at the given blocks, in as few requests as possible. */
async function fetchMessageLogs(chatId: Hex, blocks: bigint[]) {
  const sorted = [...new Set(blocks)].sort((x, y) => (x < y ? -1 : 1));
  const ranges: [bigint, bigint][] = [];
  for (const b of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && b - last[0] < MAX_SPAN) last[1] = b;
    else ranges.push([b, b]);
  }
  const results = await Promise.all(
    ranges.map(([fromBlock, toBlock]) =>
      publicClient.getLogs({ address: WHIZZ_ADDRESS!, event: messageEvent, args: { chatId }, fromBlock, toBlock, strict: true }),
    ),
  );
  return results.flat();
}

async function readText(data: Hex): Promise<string> {
  try {
    return await decryptMessage(exportPrivateKey()!, hexToBytes(data));
  } catch {
    return "🔒 Can't read this message";
  }
}

/** The most recent `limit` items of a conversation, oldest first. */
export async function loadChat(me: Address, partner: Address, limit = 40): Promise<{ chatId: Hex; entries: ChatEntry[] }> {
  const chatId = getChatId(me, partner);
  const len = await publicClient.readContract({ ...base(), functionName: "chatLength", args: [chatId] });
  const offset = len > BigInt(limit) ? len - BigInt(limit) : 0n;
  const items = await publicClient.readContract({ ...base(), functionName: "chatItems", args: [chatId, offset, BigInt(limit)] });

  const messageBlocks = items.filter((i) => i.snapId === 0n).map((i) => i.blockNumber);
  const logs = messageBlocks.length ? await fetchMessageLogs(chatId, messageBlocks) : [];
  const byIndex = new Map(logs.map((l) => [Number(l.args.index), l]));

  const entries = await Promise.all(
    items.map(async (item, k): Promise<ChatEntry | null> => {
      const index = Number(offset) + k;
      if (item.snapId === 0n) {
        const log = byIndex.get(index);
        if (!log) return null;
        return { kind: "message", index, from: log.args.from, text: await readText(log.args.data), block: item.blockNumber };
      }
      const snap = await getSnap(item.snapId);
      return { kind: "snap", index, from: snap.from, snap, block: item.blockNumber };
    }),
  );
  return { chatId, entries: entries.filter((e): e is ChatEntry => e !== null) };
}

/** Everyone you have a conversation with, newest activity first, with a preview line. */
export async function listChats(me: Address): Promise<ChatSummary[]> {
  const partners = await publicClient.readContract({ ...base(), functionName: "partnersOf", args: [me] });
  const summaries = await Promise.all(
    partners.map(async (partner): Promise<ChatSummary | null> => {
      const chatId = getChatId(me, partner);
      const len = await publicClient.readContract({ ...base(), functionName: "chatLength", args: [chatId] });
      if (len === 0n) return null;
      const [last] = await publicClient.readContract({ ...base(), functionName: "chatItems", args: [chatId, len - 1n, 1n] });
      const [name, block] = await Promise.all([nameOf(partner), publicClient.getBlock({ blockNumber: last.blockNumber })]);

      let preview = "";
      let lastFromMe = false;
      let snapMoney = false;
      let snapOpened = false;
      if (last.snapId === 0n) {
        const logs = await fetchMessageLogs(chatId, [last.blockNumber]);
        const log = logs.find((l) => l.args.index === len - 1n);
        lastFromMe = log?.args.from.toLowerCase() === me.toLowerCase();
        preview = log ? await readText(log.args.data) : "Message";
      } else {
        const snap = await getSnap(last.snapId);
        lastFromMe = snap.from.toLowerCase() === me.toLowerCase();
        snapMoney = snap.total > 0n;
        snapOpened = snap.claimed > 0n;
        preview = snapMoney ? "Snap with money" : "Snap";
      }
      return {
        partner,
        name,
        length: Number(len),
        lastBlock: last.blockNumber,
        lastTime: Number(block.timestamp),
        preview,
        lastFromMe,
        lastKind: last.snapId === 0n ? "message" : "snap",
        snapMoney,
        snapOpened,
      };
    }),
  );
  return summaries
    .filter((s): s is ChatSummary => s !== null)
    .sort((a, b) => (a.lastBlock === b.lastBlock ? 0 : a.lastBlock > b.lastBlock ? -1 : 1));
}

/** "Seen up to" marker per chat, so we can show a dot for new activity. */
const SEEN_KEY = "whizz:seen";
function seenMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}
export function markSeen(partner: Address, length: number) {
  const m = seenMap();
  m[partner.toLowerCase()] = Math.max(m[partner.toLowerCase()] ?? 0, length);
  localStorage.setItem(SEEN_KEY, JSON.stringify(m));
}
export function isUnread(chat: ChatSummary): boolean {
  return !chat.lastFromMe && chat.length > (seenMap()[chat.partner.toLowerCase()] ?? 0);
}
