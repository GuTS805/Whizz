"use client";

import { motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";
import { parseEther, parseEventLogs, type PrivateKeyAccount } from "viem";

import { whizzAbi } from "@/lib/abi";
import { publicClient, WHIZZ_ADDRESS } from "@/lib/chain";
import { useWhizzEvents } from "@/lib/events";
import { mon, nowSec, timeLeft } from "@/lib/format";
import { friendlyError, writeWhizz } from "@/lib/tx";
import { getRain, nameOf, type RainView } from "@/lib/whizz";

type RainRow = RainView & { fromName: string };

export function Rain({ account, focusRainId }: { account: PrivateKeyAccount; focusRainId: bigint | null }) {
  const [rains, setRains] = useState<RainRow[] | null>(null);
  const [caughtIds, setCaughtIds] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(nowSec);
  const [shareId, setShareId] = useState<bigint | null>(null);

  // Show the latest 6 rains (newest first), plus the one from the QR link.
  const load = useCallback(async () => {
    const count = await publicClient.readContract({ address: WHIZZ_ADDRESS!, abi: whizzAbi, functionName: "rainCount" });
    const ids = new Set<bigint>();
    for (let i = count; i > 0n && ids.size < 6; i--) ids.add(i);
    if (focusRainId && focusRainId <= count) ids.add(focusRainId);

    const list = await Promise.all(
      [...ids].map(async (id) => {
        const r = await getRain(id);
        return { ...r, fromName: await nameOf(r.from) };
      }),
    );
    const caught = await Promise.all(
      list.map((r) =>
        publicClient.readContract({
          address: WHIZZ_ADDRESS!,
          abi: whizzAbi,
          functionName: "hasCaught",
          args: [r.id, account.address],
        }),
      ),
    );
    setCaughtIds(new Set(list.filter((_, i) => caught[i]).map((r) => r.id.toString())));
    // Put the QR-linked rain on top.
    list.sort((a, b) => (a.id === focusRainId ? -1 : b.id === focusRainId ? 1 : Number(b.id - a.id)));
    setRains(list);
  }, [account.address, focusRainId]);

  useEffect(() => {
    const t = setTimeout(() => void load().catch(() => setRains([])), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), 1000);
    return () => clearInterval(id);
  }, []);

  // Live: every DropCaught / RainStarted / RainEnded anywhere refreshes the counters.
  useWhizzEvents((logs) => {
    if (logs.some((l) => l.eventName === "DropCaught" || l.eventName === "RainStarted" || l.eventName === "RainEnded")) {
      void load();
    }
  });

  return (
    <div className="absolute inset-0 overflow-y-auto p-4">
      <StartRain account={account} onStarted={(id) => { setShareId(id); void load(); }} />

      {shareId !== null && <ShareRain id={shareId} onClose={() => setShareId(null)} />}

      <h2 className="mt-6 mb-2 text-sm font-semibold text-white/60">Live rains</h2>
      {rains === null && <p className="text-white/50">Loading…</p>}
      {rains?.length === 0 && <p className="text-white/50">No rains yet. Start one ☝️</p>}
      <ul className="space-y-3">
        {rains?.map((r) => (
          <RainCard
            key={r.id.toString()}
            rain={r}
            now={now}
            account={account}
            caught={caughtIds.has(r.id.toString())}
            highlight={r.id === focusRainId}
            onShare={() => setShareId(r.id)}
            onChange={load}
          />
        ))}
      </ul>
    </div>
  );
}

function StartRain({ account, onStarted }: { account: PrivateKeyAccount; onStarted: (id: bigint) => void }) {
  const [total, setTotal] = useState("0.5");
  const [drops, setDrops] = useState("50");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const n = BigInt(drops);
      if (n < 1n || n > 1000n) throw new Error("Drops must be 1–1000");
      // The contract needs the total to split evenly, so round down to a multiple of drops.
      const wei = parseEther(total);
      const value = (wei / n) * n;
      if (value === 0n) throw new Error("Total too small for that many drops");

      const receipt = await writeWhizz({
        account,
        functionName: "startRain",
        args: [Number(n), 300n, caption || "Whizz Rain 🌧️"],
        value,
        label: "startRain",
      });
      const [started] = parseEventLogs({ abi: whizzAbi, logs: receipt.logs, eventName: "RainStarted" });
      onStarted(started.args.id);
    } catch (e) {
      setError(friendlyError(e));
    }
    setBusy(false);
  };

  return (
    <div className="rounded-3xl bg-gradient-to-br from-whizz/30 to-white/5 p-4">
      <h2 className="text-xl font-black">Make it rain 🌧️</h2>
      <p className="mb-3 text-sm text-white/60">Split MON into drops. Everyone in the room races to catch one. Lasts 5 min.</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Total MON" value={total} onChange={setTotal} inputMode="decimal" />
        <Field label="Drops" value={drops} onChange={setDrops} inputMode="numeric" />
      </div>
      <input
        value={caption}
        onChange={(e) => setCaption(e.target.value.slice(0, 60))}
        placeholder="Caption (e.g. Monad Blitz 🔥)"
        className="mt-2 w-full rounded-xl bg-black/40 px-3 py-2.5 outline-none"
      />
      <button disabled={busy} onClick={start} className="mt-3 w-full rounded-xl bg-whizz py-3 font-bold text-black disabled:opacity-40">
        {busy ? "Starting…" : "Start rain ⚡"}
      </button>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}

function RainCard({
  rain,
  now,
  account,
  caught,
  highlight,
  onShare,
  onChange,
}: {
  rain: RainRow;
  now: number;
  account: PrivateKeyAccount;
  caught: boolean;
  highlight: boolean;
  onShare: () => void;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const expired = now >= rain.expiresAt;
  const empty = rain.caught >= rain.drops;
  const over = rain.ended || expired || empty;
  const mine = rain.from.toLowerCase() === account.address.toLowerCase();
  const pct = (rain.caught / rain.drops) * 100;

  const act = async (fn: "catchDrop" | "endRain") => {
    setBusy(true);
    setMsg(null);
    try {
      await writeWhizz({ account, functionName: fn, args: [rain.id], label: fn });
      if (fn === "catchDrop") setMsg(`Caught ${mon(rain.perDrop)} MON 💧`);
      await onChange();
    } catch (e) {
      setMsg(friendlyError(e));
    }
    setBusy(false);
  };

  return (
    <li className={`rounded-2xl p-4 ${highlight ? "bg-whizz/20 ring-2 ring-whizz" : "bg-white/5"}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="font-semibold">@{rain.fromName}&apos;s rain #{rain.id.toString()}</div>
          <div className="text-xs text-white/60">
            {mon(rain.perDrop)} MON/drop · {over ? (rain.ended ? "ended" : "over") : `${timeLeft(rain.expiresAt, now)} left`}
          </div>
        </div>
        <button onClick={onShare} className="rounded-full bg-white/10 px-3 py-1 text-xs">QR</button>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
        <motion.div className="h-full bg-whizz" animate={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs text-white/60">
        {rain.caught}/{rain.drops} drops caught
      </div>

      <div className="mt-3">
        {!over && !mine && !caught && (
          <button disabled={busy} onClick={() => act("catchDrop")} className="w-full rounded-xl bg-whizz py-3 text-lg font-black text-black active:scale-95 disabled:opacity-50">
            {busy ? "Catching…" : "Catch a drop 💧"}
          </button>
        )}
        {caught && <p className="text-center text-sm text-whizz">You caught a drop 💧</p>}
        {(expired || empty) && !rain.ended && (
          <button disabled={busy} onClick={() => act("endRain")} className="mt-2 w-full rounded-xl bg-white/10 py-2 text-sm">
            {busy ? "…" : "End rain & refund leftovers"}
          </button>
        )}
      </div>
      {msg && <p className="mt-2 text-center text-sm text-white/80">{msg}</p>}
    </li>
  );
}

function ShareRain({ id, onClose }: { id: bigint; onClose: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setUrl(`${window.location.origin}/?rain=${id}`), 0);
    return () => clearTimeout(t);
  }, [id]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/95 p-6" onClick={onClose}>
      <h2 className="text-3xl font-black text-whizz">Scan to catch 💧</h2>
      {url && (
        <div className="rounded-3xl bg-white p-4">
          <QRCodeSVG value={url} size={260} />
        </div>
      )}
      <p className="text-sm break-all text-white/60">{url}</p>
      <p className="text-xs text-white/40">tap anywhere to close</p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputMode: "decimal" | "numeric";
}) {
  return (
    <label className="rounded-xl bg-black/40 px-3 py-2">
      <span className="block text-[11px] text-white/50">{label}</span>
      <input value={value} inputMode={inputMode} onChange={(e) => onChange(e.target.value)} className="w-full bg-transparent text-lg font-bold outline-none" />
    </label>
  );
}
