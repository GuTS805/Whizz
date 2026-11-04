"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address, PrivateKeyAccount } from "viem";

import { isUnread, listChats, loadChat, markSeen, MAX_MESSAGE_TEXT_BYTES, type ChatEntry, type ChatSummary } from "@/lib/chat";
import { encryptionPublicKey, encryptMessage } from "@/lib/crypto";
import { useWhizzEvents, type WhizzLog } from "@/lib/events";
import { mon, nowSec, timeLeft } from "@/lib/format";
import { outbox, useOutbox } from "@/lib/outbox";
import { friendlyError, writeWhizz } from "@/lib/tx";
import { exportPrivateKey } from "@/lib/wallet";
import { getEncryptionKey, listFriends, type FriendView, type SnapView } from "@/lib/whizz";

import { SnapViewer } from "./SnapViewer";

export type ChatPartner = { address: Address; name: string };

const lower = (a: string) => a.toLowerCase();
/** Is this a snap/message between me and (optionally) a specific partner? */
function touches(log: WhizzLog, me: string, partner?: string): boolean {
  const a = log.args as Record<string, unknown>;
  const people = [a.from, a.to].filter((x): x is string => typeof x === "string").map(lower);
  if (!people.includes(me)) return false;
  return partner ? people.includes(partner) : true;
}

// ─────────────────────────────── Chat list ───────────────────────────────

export function ChatList({ account, onOpen }: { account: PrivateKeyAccount; onOpen: (p: ChatPartner) => void }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [picking, setPicking] = useState(false);
  const me = lower(account.address);

  const load = useCallback(async () => setChats(await listChats(account.address)), [account.address]);

  useEffect(() => {
    const t = setTimeout(() => void load().catch(() => setChats([])), 0);
    return () => clearTimeout(t);
  }, [load]);

  useWhizzEvents((logs) => {
    if (logs.some((l) => (l.eventName === "MessageSent" || l.eventName === "SnapSent") && touches(l, me))) void load();
  });

  if (picking) return <NewChat account={account} onPick={onOpen} onCancel={() => setPicking(false)} />;

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between bg-black px-4 py-3">
        <h2 className="text-xl font-black">Chats</h2>
        <button onClick={() => setPicking(true)} className="rounded-full bg-whizz px-4 py-1.5 text-sm font-bold text-black">
          + New chat
        </button>
      </div>

      {chats === null && <p className="p-6 text-center text-white/50">Loading…</p>}
      {chats?.length === 0 && (
        <p className="p-10 text-center text-white/50">No chats yet. Add friends, then say hi 👋</p>
      )}
      <ul className="divide-y divide-white/5">
        {chats?.map((c) => {
          const unread = isUnread(c);
          return (
            <li key={c.partner}>
              <button onClick={() => onOpen({ address: c.partner, name: c.name })} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-whizz/20 text-lg font-black text-whizz">
                  {c.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${unread ? "font-black" : "font-semibold"}`}>@{c.name}</span>
                  <span className={`block truncate text-sm ${unread ? "text-white" : "text-white/50"}`}>
                    {c.lastFromMe ? "You: " : ""}
                    {c.preview}
                  </span>
                </span>
                {unread && <span className="h-3 w-3 shrink-0 rounded-full bg-whizz" aria-label="New" />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NewChat({ account, onPick, onCancel }: { account: PrivateKeyAccount; onPick: (p: ChatPartner) => void; onCancel: () => void }) {
  const [friends, setFriends] = useState<FriendView[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    listFriends(account.address)
      .then((f) => !cancelled && setFriends(f.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => !cancelled && setFriends([]));
    return () => {
      cancelled = true;
    };
  }, [account.address]);

  return (
    <div className="absolute inset-0 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-3">
        <button onClick={onCancel} className="text-2xl" aria-label="Back">
          ‹
        </button>
        <h2 className="text-xl font-black">New chat</h2>
      </div>
      {friends === null && <p className="text-white/50">Loading friends…</p>}
      {friends?.length === 0 && <p className="text-white/50">Add friends in the 👥 Friends tab first.</p>}
      <ul className="space-y-2">
        {friends?.map((f) => (
          <li key={f.address}>
            <button onClick={() => onPick({ address: f.address, name: f.name })} className="w-full rounded-2xl bg-white/5 px-4 py-3 text-left font-semibold">
              @{f.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─────────────────────────────── Conversation ───────────────────────────────

type Pending = { id: number; text: string; failed?: string };

export function ChatThread({
  account,
  partner,
  onBack,
  onSnap,
}: {
  account: PrivateKeyAccount;
  partner: ChatPartner;
  onBack: () => void;
  onSnap: (name: string) => void;
}) {
  const [entries, setEntries] = useState<ChatEntry[] | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [openSnap, setOpenSnap] = useState<SnapView | null>(null);
  const [now, setNow] = useState(nowSec);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pendingId = useRef(0);
  const me = lower(account.address);
  const them = lower(partner.address);

  const load = useCallback(async () => {
    const res = await loadChat(account.address, partner.address);
    setChatId(res.chatId);
    setEntries(res.entries);
    const last = res.entries[res.entries.length - 1];
    if (last) markSeen(partner.address, last.index + 1);
  }, [account.address, partner.address]);

  useEffect(() => {
    const t = setTimeout(() => void load().catch(() => setEntries([])), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), 1000);
    return () => clearInterval(id);
  }, []);

  // Snaps you just sent from the camera, still on their way to Monad.
  // (memoized: a fresh array every render would re-run the effect below each time)
  const allOutgoing = useOutbox();
  const outgoing = useMemo(() => allOutgoing.filter((s) => lower(s.to) === them), [allOutgoing, them]);

  // Once Monad confirms a snap, load it from the chain, then drop the placeholder
  // (in that order, so the bubble never blinks out).
  useEffect(() => {
    const done = outgoing.filter((s) => s.status === "sent");
    if (done.length === 0) return;
    void load()
      .catch(() => {})
      .finally(() => done.forEach((s) => outbox.remove(s.id)));
  }, [outgoing, load]);

  // Keep the newest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries, pending, outgoing.length]);

  useWhizzEvents((logs) => {
    // Snaps already in this chat — so we only react to unwraps/refunds of THESE snaps,
    // not to every unwrap happening anywhere on the network.
    const snapIds = new Set(entries?.flatMap((e) => (e.kind === "snap" ? [e.snap.id] : [])) ?? []);
    const relevant = logs.some((l) => {
      if (l.eventName === "MessageSent") return (l.args as { chatId: string }).chatId === chatId;
      if (l.eventName === "SnapSent") return touches(l, me, them);
      if (l.eventName === "Unwrapped" || l.eventName === "Reclaimed") return snapIds.has((l.args as { id: bigint }).id);
      return false;
    });
    if (relevant) void load();
  });

  const bytes = new TextEncoder().encode(text).length;
  const tooLong = bytes > MAX_MESSAGE_TEXT_BYTES;

  const send = async () => {
    const message = text.trim();
    if (!message || tooLong) return;
    setError(null);
    setText("");
    const id = ++pendingId.current;
    setPending((p) => [...p, { id, text: message }]);
    try {
      const theirKey = await getEncryptionKey(partner.address);
      if (!theirKey) throw new Error(`@${partner.name} can't receive private messages yet`);
      const data = await encryptMessage(message, theirKey, encryptionPublicKey(exportPrivateKey()!));
      await writeWhizz({ account, functionName: "sendMessage", args: [partner.address, data], label: "message" });
      await load();
      setPending((p) => p.filter((x) => x.id !== id));
    } catch (e) {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, failed: friendlyError(e) } : x)));
    }
  };

  if (openSnap) {
    return (
      <SnapViewer
        account={account}
        snap={openSnap}
        senderName={partner.name}
        onClose={() => {
          setOpenSnap(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-3 border-b border-white/10 px-3 py-2">
        <button onClick={onBack} className="px-2 text-3xl leading-none" aria-label="Back to chats">
          ‹
        </button>
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-whizz/20 font-black text-whizz">
          {partner.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold">@{partner.name}</div>
          <div className="text-[11px] text-white/40">🔒 End-to-end encrypted · on Monad</div>
        </div>
        <button onClick={() => onSnap(partner.name)} className="rounded-full bg-whizz px-3 py-1.5 text-sm font-bold text-black" aria-label="Send a snap">
          📸
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-4">
        {entries === null && <p className="text-center text-white/50">Loading…</p>}
        {entries?.length === 0 && pending.length === 0 && outgoing.length === 0 && (
          <p className="pt-10 text-center text-white/50">Say hi to @{partner.name} 👋</p>
        )}
        {entries?.map((e) =>
          e.kind === "message" ? (
            <Bubble key={e.index} mine={lower(e.from) === me}>
              {e.text}
            </Bubble>
          ) : (
            <SnapBubble
              key={e.index}
              account={account}
              snap={e.snap}
              mine={lower(e.from) === me}
              now={now}
              onOpen={() => setOpenSnap(e.snap)}
              onChange={load}
            />
          ),
        )}
        {outgoing.map((s) => (
          <div key={`snap-${s.id}`} className="flex flex-col items-end">
            <div
              className={`max-w-[78%] rounded-2xl border border-whizz/50 bg-whizz/10 px-4 py-3 text-sm font-semibold ${
                s.status === "failed" ? "" : "animate-pulse"
              }`}
            >
              {s.amount > 0n ? `🎁 Snap · ${mon(s.amount)} MON` : "📸 Snap"}
            </div>
            {s.status === "failed" ? (
              <span className="mt-0.5 flex items-center gap-2 text-[11px] text-red-400">
                Not sent: {s.error}
                <button onClick={() => outbox.retry(s.id)} className="rounded-full bg-white/10 px-2 py-0.5 text-white">
                  Retry
                </button>
                <button onClick={() => outbox.remove(s.id)} className="text-white/60" aria-label="Discard snap">
                  ✕
                </button>
              </span>
            ) : (
              <span className="mt-0.5 text-[11px] text-white/40">Sending ⚡</span>
            )}
          </div>
        ))}
        {pending.map((p) => (
          <div key={p.id} className="flex flex-col items-end">
            <Bubble mine dim={!p.failed}>
              {p.text}
            </Bubble>
            <span className={`mt-0.5 text-[11px] ${p.failed ? "text-red-400" : "text-white/40"}`}>
              {p.failed ? `Not sent: ${p.failed}` : "Sending ⚡"}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-white/10 p-3">
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Chat"
            className="min-w-0 flex-1 rounded-full bg-white/10 px-4 py-3 outline-none"
          />
          <button
            disabled={!text.trim() || tooLong}
            onClick={() => void send()}
            className="rounded-full bg-whizz px-5 font-bold text-black disabled:opacity-40"
          >
            Send
          </button>
        </div>
        {tooLong && <p className="mt-1 text-xs text-red-400">Message too long ({bytes}/{MAX_MESSAGE_TEXT_BYTES} bytes)</p>}
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}

function Bubble({ mine, dim, children }: { mine: boolean; dim?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-4 py-2 break-words whitespace-pre-wrap ${
          mine ? "rounded-br-sm bg-whizz text-black" : "rounded-bl-sm bg-white/10"
        } ${dim ? "opacity-60" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}

function SnapBubble({
  account,
  snap,
  mine,
  now,
  onOpen,
  onChange,
}: {
  account: PrivateKeyAccount;
  snap: SnapView;
  mine: boolean;
  now: number;
  onOpen: () => void;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasMoney = snap.total > 0n;
  const left = snap.total - snap.claimed;
  const expired = now >= snap.expiresAt;
  const opened = hasMoney && left === 0n && snap.claimed > 0n;

  let label: string;
  if (mine) {
    if (!hasMoney) label = expired ? "📸 Snap · gone 💨" : "📸 You sent a snap";
    else if (opened) label = `🎁 Snap · opened (${mon(snap.total)} MON) ✓`;
    else if (left === 0n) label = "🎁 Snap · money returned 💨";
    else if (expired) label = `🎁 Snap · not opened — ${mon(left)} MON can come back`;
    else label = `🎁 Snap · ${mon(snap.claimed)}/${mon(snap.total)} MON unwrapped · ${timeLeft(snap.expiresAt, now)}`;
  } else {
    if (expired) label = hasMoney && left === 0n && snap.claimed > 0n ? `🎁 Opened · +${mon(snap.claimed)} MON` : "💨 Gone";
    else if (hasMoney && left > 0n) label = `🎁 Tap to open · ${mon(left)} MON inside`;
    else if (hasMoney) label = `🎁 Opened · +${mon(snap.claimed)} MON`;
    else label = "📸 Tap to view";
  }

  const canOpen = !mine && !expired;
  const canReclaim = mine && hasMoney && expired && left > 0n;

  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <button
        disabled={!canOpen}
        onClick={onOpen}
        className={`max-w-[78%] rounded-2xl border px-4 py-3 text-left text-sm font-semibold ${
          mine ? "border-whizz/50 bg-whizz/10" : canOpen ? "border-whizz bg-whizz/20" : "border-white/10 bg-white/5"
        }`}
      >
        {label}
      </button>
      {canReclaim && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              // Unopened money goes back to you (anyone can trigger it; it only pays the sender).
              await writeWhizz({ account, functionName: "reclaim", args: [snap.id], label: "reclaim" });
              await onChange();
            } catch (e) {
              setError(friendlyError(e));
            }
            setBusy(false);
          }}
          className="mt-1 rounded-full bg-white/10 px-3 py-1 text-xs"
        >
          {busy ? "…" : "Poof it back 💨"}
        </button>
      )}
      {error && <span className="mt-0.5 text-[11px] text-red-400">{error}</span>}
    </div>
  );
}
