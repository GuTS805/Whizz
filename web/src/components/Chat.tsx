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
import { Avatar, Icon, STATUS, StatusMark, timeAgo } from "./ui";

export type ChatPartner = { address: Address; name: string };

const lower = (a: string) => a.toLowerCase();
/** Is this a snap/message between me and (optionally) a specific partner? */
function touches(log: WhizzLog, me: string, partner?: string): boolean {
  const a = log.args as Record<string, unknown>;
  const people = [a.from, a.to].filter((x): x is string => typeof x === "string").map(lower);
  if (!people.includes(me)) return false;
  return partner ? people.includes(partner) : true;
}

/** The colour + mark + word under a name in the chat list (Snapchat-style status). */
function chatStatus(c: ChatSummary) {
  const color = c.lastKind === "message" ? STATUS.chat : c.snapMoney ? STATUS.money : STATUS.snap;
  if (c.lastFromMe) {
    const opened = c.lastKind === "snap" && c.snapOpened;
    return { color, kind: opened ? ("opened" as const) : ("sent" as const), text: opened ? "Opened" : "Delivered", bold: false };
  }
  if (isUnread(c)) {
    const text = c.lastKind === "message" ? "New Chat" : c.snapMoney ? "New Snap with money" : "New Snap";
    return { color, kind: "new" as const, text, bold: true };
  }
  return { color, kind: "seen" as const, text: "Received", bold: false };
}

// ─────────────────────────────── Chat list ───────────────────────────────

export function ChatList({
  account,
  onOpen,
  onSnap,
}: {
  account: PrivateKeyAccount;
  onOpen: (p: ChatPartner) => void;
  onSnap: (name: string) => void;
}) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [now, setNow] = useState(nowSec);
  const me = lower(account.address);

  const load = useCallback(async () => setChats(await listChats(account.address)), [account.address]);

  useEffect(() => {
    const t = setTimeout(() => void load().catch(() => setChats([])), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), 30_000);
    return () => clearInterval(id);
  }, []);

  useWhizzEvents((logs) => {
    if (logs.some((l) => (l.eventName === "MessageSent" || l.eventName === "SnapSent") && touches(l, me))) void load();
  });

  if (picking) return <NewChat account={account} onPick={onOpen} onCancel={() => setPicking(false)} />;

  return (
    <div className="absolute inset-0 overflow-y-auto pb-24">
      {chats === null && <ListSkeleton />}
      {chats?.length === 0 && (
        <div className="flex flex-col items-center px-10 pt-20 text-center">
          <Icon.Chat size={48} className="text-white/25" />
          <p className="mt-4 font-bold">No chats yet</p>
          <p className="mt-1 text-sm text-white/50">Add friends, then send them a snap or say hi.</p>
        </div>
      )}
      <ul>
        {chats?.map((c) => {
          const s = chatStatus(c);
          return (
            <li key={c.partner} className="flex items-center border-b border-white/[0.06]">
              <button onClick={() => onOpen({ address: c.partner, name: c.name })} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left active:bg-white/5">
                <Avatar name={c.name} size={48} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold">{c.name}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[13px]">
                    <StatusMark kind={s.kind} color={s.color} />
                    <span className={s.bold ? "font-extrabold" : "text-white/55"} style={s.bold ? { color: s.color } : undefined}>
                      {s.text}
                    </span>
                    <span className="text-white/40">· {timeAgo(c.lastTime, now)}</span>
                  </span>
                </span>
              </button>
              <button onClick={() => onSnap(c.name)} aria-label={`Snap @${c.name}`} className="p-4 text-white/60 active:text-white">
                <Icon.Camera size={22} />
              </button>
            </li>
          );
        })}
      </ul>

      <button
        onClick={() => setPicking(true)}
        aria-label="New chat"
        className="absolute right-4 bottom-4 flex h-14 w-14 items-center justify-center rounded-full bg-whizz text-black shadow-xl active:scale-95"
      >
        <Icon.NewChat size={24} />
      </button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 pt-1" aria-label="Loading chats">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex animate-pulse items-center gap-3 px-4 py-2.5">
          <span className="h-12 w-12 rounded-full bg-white/10" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-28 rounded bg-white/10" />
            <span className="block h-2.5 w-40 rounded bg-white/[0.06]" />
          </span>
        </div>
      ))}
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
    <div className="absolute inset-0 overflow-y-auto">
      <div className="flex items-center gap-2 px-2 pt-1 pb-2">
        <button onClick={onCancel} className="p-2" aria-label="Back">
          <Icon.Back size={24} />
        </button>
        <h2 className="text-lg font-extrabold">New Chat</h2>
      </div>
      {friends === null && <ListSkeleton />}
      {friends?.length === 0 && <p className="px-4 text-white/50">Add friends in the Friends tab first.</p>}
      <ul>
        {friends?.map((f) => (
          <li key={f.address}>
            <button onClick={() => onPick({ address: f.address, name: f.name })} className="flex w-full items-center gap-3 px-4 py-2.5 text-left active:bg-white/5">
              <Avatar name={f.name} size={44} />
              <span className="font-bold">{f.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─────────────────────────────── Conversation ───────────────────────────────

type Pending = { id: number; text: string; failed?: string };

/** One line in the conversation, already tagged with who sent it (for the ME / NAME labels). */
type Line =
  | { key: string; mine: boolean; type: "entry"; entry: ChatEntry }
  | { key: string; mine: true; type: "outgoingSnap"; id: number; amount: bigint; failed?: string }
  | { key: string; mine: true; type: "pending"; p: Pending };

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
  // (in that order, so it never blinks out).
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

  const lines: Line[] = [
    ...(entries ?? []).map((e): Line => ({ key: `e${e.index}`, mine: lower(e.from) === me, type: "entry", entry: e })),
    ...outgoing.map((s): Line => ({ key: `o${s.id}`, mine: true, type: "outgoingSnap", id: s.id, amount: s.amount, failed: s.status === "failed" ? s.error : undefined })),
    ...pending.map((p): Line => ({ key: `p${p.id}`, mine: true, type: "pending", p })),
  ];

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="safe-top border-b border-white/[0.06]">
        <div className="flex items-center gap-2 px-2 py-2">
          <button onClick={onBack} className="p-2" aria-label="Back to chats">
            <Icon.Back size={24} />
          </button>
          <Avatar name={partner.name} size={36} />
          <div className="min-w-0 flex-1 pl-1">
            <div className="truncate font-extrabold">{partner.name}</div>
            <div className="text-[11px] text-white/45">End-to-end encrypted · on Monad</div>
          </div>
          <button onClick={() => onSnap(partner.name)} className="p-2.5" aria-label="Send a snap">
            <Icon.Camera size={24} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {entries === null && <p className="pt-10 text-center text-sm text-white/40">Loading…</p>}
        {entries?.length === 0 && lines.length === 0 && (
          <div className="flex flex-col items-center pt-16 text-center">
            <Avatar name={partner.name} size={72} />
            <p className="mt-3 text-lg font-extrabold">{partner.name}</p>
            <p className="mt-1 text-sm text-white/50">Send a snap or say hi 👋</p>
          </div>
        )}
        {lines.map((line, i) => {
          const showLabel = i === 0 || lines[i - 1].mine !== line.mine;
          const color = line.mine ? STATUS.snap : STATUS.chat;
          return (
            <div key={line.key}>
              {showLabel && (
                <div className="mt-3 mb-1 text-[11px] font-extrabold tracking-wide uppercase" style={{ color }}>
                  {line.mine ? "Me" : partner.name}
                </div>
              )}
              <div className="border-l-2 py-0.5 pl-2.5" style={{ borderColor: color }}>
                {line.type === "entry" && line.entry.kind === "message" && (
                  <p className="text-[15px] break-words whitespace-pre-wrap">{line.entry.text}</p>
                )}
                {line.type === "entry" && line.entry.kind === "snap" && (
                  <SnapLine
                    account={account}
                    snap={line.entry.snap}
                    mine={line.mine}
                    now={now}
                    onOpen={() => line.entry.kind === "snap" && setOpenSnap(line.entry.snap)}
                    onChange={load}
                  />
                )}
                {line.type === "outgoingSnap" && (
                  <div className="py-1">
                    <span className="flex items-center gap-2 text-sm font-bold">
                      <StatusMark kind="sent" color={line.amount > 0n ? STATUS.money : STATUS.snap} />
                      {line.amount > 0n ? `Snap · ${mon(line.amount)} MON` : "Snap"}
                      {!line.failed && <span className="animate-pulse font-semibold text-white/45">Sending…</span>}
                    </span>
                    {line.failed && (
                      <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#ff6b81]">
                        Not sent: {line.failed}
                        <button onClick={() => outbox.retry(line.id)} className="rounded-full bg-white/10 px-2.5 py-0.5 font-bold text-white">
                          Retry
                        </button>
                        <button onClick={() => outbox.remove(line.id)} className="font-bold text-white/50">
                          Discard
                        </button>
                      </span>
                    )}
                  </div>
                )}
                {line.type === "pending" && (
                  <div>
                    <p className={`text-[15px] break-words whitespace-pre-wrap ${line.p.failed ? "" : "text-white/50"}`}>{line.p.text}</p>
                    <span className={`text-[11px] ${line.p.failed ? "text-[#ff6b81]" : "text-white/35"}`}>
                      {line.p.failed ? `Not sent: ${line.p.failed}` : "Sending…"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-white/[0.06] px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSnap(partner.name)}
            aria-label="Send a snap"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10"
          >
            <Icon.Camera size={20} />
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Send a chat"
            className="min-w-0 flex-1 rounded-full bg-white/10 px-4 py-2.5 outline-none placeholder:text-white/40"
          />
          {text.trim() && (
            <button
              disabled={tooLong}
              onClick={() => void send()}
              aria-label="Send"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0fadff] text-white disabled:opacity-40"
            >
              <Icon.Send size={20} />
            </button>
          )}
        </div>
        {tooLong && <p className="mt-1 text-xs text-[#ff6b81]">Too long ({bytes}/{MAX_MESSAGE_TEXT_BYTES} bytes)</p>}
      </div>
    </div>
  );
}

/** A snap inside the conversation: a status line you tap to open (or reclaim when it expired unopened). */
function SnapLine({
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
  const color = hasMoney ? STATUS.money : STATUS.snap;

  let label: string;
  let kind: "new" | "seen" | "sent" | "opened";
  if (mine) {
    kind = opened || snap.claimed > 0n ? "opened" : "sent";
    if (!hasMoney) label = expired ? "Snap · gone" : "Delivered";
    else if (opened) label = `Opened · ${mon(snap.total)} MON unwrapped`;
    else if (left === 0n) label = "Money came back to you";
    else if (expired) label = `Not opened · ${mon(left)} MON can come back`;
    else label = `${mon(snap.claimed)}/${mon(snap.total)} MON unwrapped · ${timeLeft(snap.expiresAt, now)} left`;
  } else {
    if (expired) {
      kind = "seen";
      label = hasMoney && snap.claimed > 0n ? `Opened · +${mon(snap.claimed)} MON` : "Gone";
    } else if (hasMoney && left > 0n) {
      kind = "new";
      label = `Tap to open · ${mon(left)} MON inside`;
    } else if (hasMoney) {
      kind = "seen";
      label = `Opened · +${mon(snap.claimed)} MON`;
    } else {
      kind = "new";
      label = "Tap to view";
    }
  }

  const canOpen = !mine && !expired;
  const canReclaim = mine && hasMoney && expired && left > 0n;

  return (
    <div className="py-1">
      <button disabled={!canOpen} onClick={onOpen} className="flex items-center gap-2 text-left text-sm font-bold disabled:cursor-default">
        <StatusMark kind={kind} color={color} />
        <span style={kind === "new" ? { color } : undefined} className={kind === "new" ? "" : "text-white/80"}>
          {label}
        </span>
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
          className="mt-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-bold"
        >
          {busy ? "…" : "Get it back"}
        </button>
      )}
      {error && <span className="mt-0.5 block text-[11px] text-[#ff6b81]">{error}</span>}
    </div>
  );
}
