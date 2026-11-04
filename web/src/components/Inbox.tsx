"use client";

import { useCallback, useEffect, useState } from "react";
import type { PrivateKeyAccount } from "viem";

import { useWhizzEvents } from "@/lib/events";
import { mon, nowSec, timeLeft } from "@/lib/format";
import { friendlyError, writeWhizz } from "@/lib/tx";
import { getSnap, listSnapIds, nameOf, type SnapView } from "@/lib/whizz";

import { SnapViewer } from "./SnapViewer";

type Row = SnapView & { otherName: string };

export function Inbox({ account }: { account: PrivateKeyAccount }) {
  const [box, setBox] = useState<"inbox" | "outbox">("inbox");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<Row | null>(null);
  const [now, setNow] = useState(nowSec);

  const load = useCallback(async () => {
    const ids = await listSnapIds(account.address, box);
    const snaps = await Promise.all(ids.map(getSnap));
    const withNames = await Promise.all(
      snaps.map(async (s) => ({ ...s, otherName: await nameOf(box === "inbox" ? s.from : s.to) })),
    );
    setRows(withNames);
  }, [account.address, box]);

  useEffect(() => {
    const t = setTimeout(() => void load().catch(() => setRows([])), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), 1000);
    return () => clearInterval(id);
  }, []);

  // A new snap / unwrap / reclaim touching me → refresh the list instantly.
  useWhizzEvents((logs) => {
    const me = account.address.toLowerCase();
    const relevant = logs.some((l) => {
      const a = l.args as Record<string, unknown>;
      return [a.to, a.from].some((x) => typeof x === "string" && x.toLowerCase() === me) || l.eventName === "Reclaimed";
    });
    if (relevant) void load();
  });

  if (open) {
    return (
      <SnapViewer
        account={account}
        snap={open}
        senderName={open.otherName}
        onClose={() => {
          setOpen(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="sticky top-0 z-10 flex gap-2 bg-black p-3">
        {(["inbox", "outbox"] as const).map((b) => (
          <button
            key={b}
            onClick={() => {
              setRows(null);
              setBox(b);
            }}
            className={`flex-1 rounded-full py-2 text-sm font-semibold ${box === b ? "bg-white text-black" : "bg-white/10"}`}
          >
            {b === "inbox" ? "Received" : "Sent"}
          </button>
        ))}
      </div>

      {rows === null && <p className="p-6 text-center text-white/50">Loading…</p>}
      {rows?.length === 0 && (
        <p className="p-10 text-center text-white/50">
          {box === "inbox" ? "No snaps yet. Tell a friend your @name 👀" : "You haven't sent anything yet 📸"}
        </p>
      )}

      <ul className="divide-y divide-white/5">
        {rows?.map((s) => (
          <SnapRow key={s.id.toString()} snap={s} box={box} now={now} account={account} onOpen={() => setOpen(s)} />
        ))}
      </ul>
    </div>
  );
}

function SnapRow({
  snap,
  box,
  now,
  account,
  onOpen,
}: {
  snap: Row;
  box: "inbox" | "outbox";
  now: number;
  account: PrivateKeyAccount;
  onOpen: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const left = snap.total - snap.claimed;
  const expired = now >= snap.expiresAt;
  const hasMoney = snap.total > 0n;

  let status: string;
  let icon: string;
  if (!hasMoney) {
    status = expired ? "Gone 💨" : `Photo · ${timeLeft(snap.expiresAt, now)} left`;
    icon = "📷";
  } else if (left === 0n) {
    status = snap.claimed > 0n ? `Opened · ${mon(snap.total)} MON` : "Returned";
    icon = "✅";
  } else if (expired) {
    status = `Poof! ${mon(left)} MON returning to sender`;
    icon = "💨";
  } else {
    status = `${mon(left)} MON inside · ${timeLeft(snap.expiresAt, now)}`;
    icon = "🎁";
  }

  const canOpen = box === "inbox" && !expired;
  const canReclaim = hasMoney && expired && left > 0n;

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <button disabled={!canOpen} onClick={onOpen} className="flex flex-1 items-center gap-3 text-left disabled:opacity-60">
        <span className={`flex h-12 w-12 items-center justify-center rounded-2xl text-2xl ${canOpen && left > 0n ? "bg-whizz" : "bg-white/10"}`}>
          {icon}
        </span>
        <span>
          <span className="block font-semibold">{box === "inbox" ? "from" : "to"} @{snap.otherName}</span>
          <span className="block text-sm text-white/60">{status}</span>
        </span>
      </button>
      {canReclaim && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              // Anyone can trigger the refund — the money still only goes to the sender.
              await writeWhizz({ account, functionName: "reclaim", args: [snap.id], label: "reclaim" });
            } catch (e) {
              alert(friendlyError(e));
            }
            setBusy(false);
          }}
          className="rounded-full bg-white/10 px-3 py-1.5 text-xs"
        >
          {busy ? "…" : "Poof it 💨"}
        </button>
      )}
    </li>
  );
}
