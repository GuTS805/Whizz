"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BaseError,
  ContractFunctionRevertedError,
  hexToBytes,
  parseEther,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";

import { encryptSnap } from "@/lib/crypto";
import { BADGE_TEXT, FILTERS, filterCss, supportsCanvasFilters, timeLabel, type FilterId, type Overlays } from "@/lib/filters";
import { mon } from "@/lib/format";
import { captureFrame } from "@/lib/image";
import { outbox } from "@/lib/outbox";
import { estimateWhizzGas, friendlyError, writeWhizz } from "@/lib/tx";
import { addressForName, getEncryptionKey, listFriends, type FriendView } from "@/lib/whizz";

import { SpeedPill } from "./Scoreboard";
import { Avatar, Icon } from "./ui";

const AMOUNTS = ["0", "0.01", "0.05", "0.1"] as const;
const TIMERS = [
  { label: "2m", secs: 120n },
  { label: "1h", secs: 3600n },
  { label: "24h", secs: 86400n },
] as const;

type Shot = { hex: Hex; url: string };

export function Camera({
  account,
  name,
  balance,
  presetTo,
  onProfile,
  onSpeed,
  onSent,
}: {
  account: PrivateKeyAccount;
  name: string;
  balance: bigint | null;
  /** Friend chosen elsewhere ("snap @x"), pre-selected as recipient. */
  presetTo: string | null;
  onProfile: () => void;
  onSpeed: () => void;
  /** Called with the recipient, so the app can open that conversation. */
  onSent: (to: { address: Address; name: string }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [camError, setCamError] = useState<string | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [filter, setFilter] = useState<FilterId>("normal");
  const [overlays, setOverlays] = useState<Overlays>({ time: false, badge: false });
  const [clock, setClock] = useState(() => timeLabel());
  // Filters are only offered where the photo can match the preview (see supportsCanvasFilters).
  const filtersAvailable = supportsCanvasFilters();

  // Keep the time-stamp preview current.
  useEffect(() => {
    if (!overlays.time) return;
    const id = setInterval(() => setClock(timeLabel()), 10_000);
    return () => clearInterval(id);
  }, [overlays.time]);

  // Browsers only expose the camera on https (or localhost).
  // Safe to read during render: this component only mounts in the browser after login.
  const camSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices;

  useEffect(() => {
    if (shot || !camSupported) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing, width: { ideal: 720 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setCamError(null);
      })
      .catch(() => setCamError("Allow camera access to snap"));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing, shot, camSupported]);

  const snap = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setShot(await captureFrame(v, facing === "user", { filter: filterCss(filter), overlays }));
  }, [facing, filter, overlays]);

  if (shot) {
    return <Compose account={account} shot={shot} presetTo={presetTo} onCancel={() => setShot(null)} onSent={onSent} />;
  }

  return (
    <div className="absolute inset-0 overflow-hidden bg-neutral-900">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ filter: filterCss(filter) }}
        className={`h-full w-full object-cover ${facing === "user" ? "-scale-x-100" : ""}`}
      />

      {/* Live preview of the overlays — drawn the same way onto the captured photo. */}
      {overlays.badge && (
        <div className="pointer-events-none absolute top-28 left-1/2 -translate-x-1/2 rounded-full bg-whizz px-4 py-1.5 text-sm font-extrabold whitespace-nowrap text-black">
          {BADGE_TEXT}
        </div>
      )}
      {overlays.time && (
        <div className="pointer-events-none absolute bottom-52 left-5 text-6xl font-black text-white drop-shadow-lg">{clock}</div>
      )}

      {(camError || !camSupported) && (
        <p className="absolute inset-x-8 top-1/3 text-center font-semibold text-white/80">
          {camSupported ? camError : "The camera needs https on phones."}
        </p>
      )}

      {/* Top bar: you · balance … speed */}
      <div className="safe-top absolute inset-x-0 top-0 bg-gradient-to-b from-black/50 to-transparent">
        <div className="flex items-center gap-2 px-3 pt-3 pb-6">
          <button onClick={onProfile} aria-label="Profile and wallet" className="rounded-full ring-2 ring-white/80">
            <Avatar name={name} size={36} />
          </button>
          <button onClick={onProfile} className="rounded-full bg-black/40 px-3 py-1.5 text-xs font-bold backdrop-blur">
            {balance === null ? "…" : `${mon(balance, 3)} MON`}
          </button>
          <div className="flex-1" />
          <SpeedPill onClick={onSpeed} />
        </div>
        {presetTo && (
          <div className="-mt-3 flex justify-center">
            <span className="rounded-full bg-black/50 px-4 py-1.5 text-sm font-semibold backdrop-blur">
              Snapping <span className="font-black text-whizz">@{presetTo}</span>
            </span>
          </div>
        )}
      </div>

      {/* Tools, right side */}
      <div className="safe-top absolute top-16 right-3 flex flex-col gap-3">
        <Tool label="Flip camera" onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}>
          <Icon.Flip size={22} />
        </Tool>
        <Tool label="Time stamp" active={overlays.time} onClick={() => setOverlays((o) => ({ ...o, time: !o.time }))}>
          <Icon.Clock size={22} />
        </Tool>
        <Tool label="Event badge" active={overlays.badge} onClick={() => setOverlays((o) => ({ ...o, badge: !o.badge }))}>
          <Icon.Tag size={22} />
        </Tool>
      </div>

      {/* Shutter + lens carousel */}
      <div className="absolute inset-x-0 bottom-5 flex flex-col items-center gap-4">
        <button
          onClick={snap}
          aria-label="Take snap"
          className="h-[78px] w-[78px] rounded-full border-[5px] border-white bg-white/10 shadow-lg transition-transform active:scale-90"
        />
        {filtersAvailable && (
          <div className="flex w-full snap-x gap-3 overflow-x-auto px-[calc(50%-26px)] pb-1 [scrollbar-width:none]">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                aria-label={`${f.label} filter`}
                aria-pressed={filter === f.id}
                className="flex shrink-0 snap-center flex-col items-center gap-1"
              >
                <span
                  className={`block h-[52px] w-[52px] rounded-full bg-[conic-gradient(at_50%_50%,#ffb36b,#ff5f8f,#836ef9,#3fc1ff,#7ee08a,#ffb36b)] ${
                    filter === f.id ? "ring-[3px] ring-white" : "ring-2 ring-white/30"
                  }`}
                  style={{ filter: f.css }}
                />
                <span className={`text-[10px] font-bold ${filter === f.id ? "text-white" : "text-white/60"}`}>
                  {f.label.replace(/\s*💜/, "")}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tool({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-11 w-11 items-center justify-center rounded-full backdrop-blur transition-colors ${
        active ? "bg-whizz text-black" : "bg-black/35 text-white"
      }`}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────── Preview → Send To ───────────────────────────────

function Compose({
  account,
  shot,
  presetTo,
  onCancel,
  onSent,
}: {
  account: PrivateKeyAccount;
  shot: Shot;
  presetTo: string | null;
  onCancel: () => void;
  onSent: (to: { address: Address; name: string }) => void;
}) {
  const [step, setStep] = useState<"edit" | "sendTo">("edit");
  const [to, setTo] = useState(presetTo ?? "");
  const [friends, setFriends] = useState<FriendView[] | null>(null);
  const [caption, setCaption] = useState("");
  const [editingCaption, setEditingCaption] = useState(false);
  const [amount, setAmount] = useState<string>("0.01");
  const [moneyOpen, setMoneyOpen] = useState(false);
  const [timerIdx, setTimerIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = TIMERS[timerIdx].secs;

  // Friends as one-tap recipients (mutual friends first).
  useEffect(() => {
    let cancelled = false;
    listFriends(account.address)
      .then((f) => {
        if (!cancelled) setFriends(f.sort((a, b) => Number(b.mutual) - Number(a.mutual) || a.name.localeCompare(b.name)));
      })
      .catch(() => !cancelled && setFriends([]));
    return () => {
      cancelled = true;
    };
  }, [account.address]);

  // Do the slow lookups WHILE the user is still composing, so Send is instant.
  const prepRef = useRef<{ key: string; promise: Promise<Prepared> } | null>(null);
  const prepare = useCallback(
    (name: string, value: bigint) => {
      const k = `${name}|${value}`; // the estimate also checks you can afford the amount
      if (prepRef.current?.key !== k) {
        const known = friends?.find((f) => f.name === name)?.address;
        prepRef.current = { key: k, promise: prepareSnap(account, name, known, value, shot.hex) };
      }
      return prepRef.current.promise;
    },
    [account, friends, shot.hex],
  );
  useEffect(() => {
    if (to.length < 3) return;
    // Wait for typing to pause; tapping a friend sets the full name at once.
    const t = setTimeout(() => void prepare(to, parseEther(amount)), 300);
    return () => clearTimeout(t);
  }, [to, amount, prepare]);

  const send = async () => {
    setError(null);
    setBusy(true);
    const value = parseEther(amount);
    let prep = await prepare(to, value);
    if (prep.error) {
      // It may have been fixed since (e.g. you just got gas) — check once more.
      prepRef.current = null;
      prep = await prepare(to, value);
    }
    if (prep.error || !prep.recipient) {
      setError(prep.error ?? `No one called @${to} yet`);
      setBusy(false);
      return;
    }
    // Private snap: encrypt photo + caption to the recipient's key, so the
    // chain only stores ciphertext. (Every Whizz sign-up publishes a key.)
    if (!prep.key && !window.confirm(`@${to} hasn't enabled private snaps yet. Send this snap unencrypted (anyone could view it)?`)) {
      setBusy(false);
      return;
    }
    const { recipient, key, gas, baseBytes } = prep;
    outbox.send(recipient, value, async () => {
      const payload = key ? await encryptSnap(key, caption, hexToBytes(shot.hex)) : shot.hex;
      // Encrypted snaps carry the caption inside the ciphertext, not in the clear.
      const clearCaption = key ? "" : caption;
      // The gas was estimated without the caption — add room for its bytes
      // (calldata + event log ≈ 24 gas/byte; 40 leaves margin on top of the 15% buffer).
      const extra = BigInt(payloadBytes(payload) + utf8Bytes(clearCaption) - baseBytes);
      return writeWhizz({
        account,
        functionName: "sendSnap",
        args: [recipient, timer, clearCaption, payload],
        value,
        gas: gas ? gas + (extra > 0n ? extra * 40n : 0n) : undefined,
        label: "sendSnap",
      });
    });
    // Don't wait for Monad — open the chat now; it shows the snap as "Sending".
    onSent({ address: recipient, name: to });
  };

  if (step === "sendTo") {
    return (
      <SendTo
        friends={friends}
        to={to}
        amount={amount}
        busy={busy}
        error={error}
        onPick={(n) => {
          setTo(n);
          setError(null);
        }}
        onBack={() => setStep("edit")}
        onSend={send}
      />
    );
  }

  const hasMoney = Number(amount) > 0;

  return (
    <div className="absolute inset-0 bg-black">
      {/* eslint-disable-next-line @next/next/no-img-element -- local blob URL */}
      <img src={shot.url} alt="Your snap" className="h-full w-full object-cover" />

      {hasMoney && (
        <button
          onClick={() => setMoneyOpen(true)}
          className="absolute top-1/4 left-1/2 -translate-x-1/2 rotate-[-4deg] rounded-2xl bg-whizz px-5 py-2.5 text-2xl font-black text-black shadow-xl"
        >
          {amount} MON
        </button>
      )}

      {/* Caption bar, Snapchat style: a band across the photo. */}
      {(editingCaption || caption) && (
        <input
          autoFocus={editingCaption}
          value={caption}
          onChange={(e) => setCaption(e.target.value.slice(0, 80))}
          onBlur={() => setEditingCaption(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="Say something…"
          className="absolute inset-x-0 top-[60%] bg-black/55 px-4 py-2.5 text-center text-lg font-semibold text-white outline-none placeholder:text-white/50"
        />
      )}

      <button onClick={onCancel} aria-label="Discard snap" className="safe-top absolute top-3 left-3 p-2 text-white drop-shadow">
        <Icon.Close size={28} />
      </button>

      <div className="safe-top absolute top-3 right-3 flex flex-col items-center gap-4">
        <Tool label="Add text" active={editingCaption || !!caption} onClick={() => setEditingCaption(true)}>
          <Icon.Text size={22} />
        </Tool>
        <Tool label="Add money" active={hasMoney} onClick={() => setMoneyOpen(true)}>
          <Icon.Money size={22} />
        </Tool>
        <div className="flex flex-col items-center gap-1">
          <Tool label="Disappear timer" onClick={() => setTimerIdx((i) => (i + 1) % TIMERS.length)}>
            <Icon.Timer size={22} />
          </Tool>
          <span className="rounded-full bg-black/50 px-2 py-0.5 text-[11px] font-bold">{TIMERS[timerIdx].label}</span>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/60 to-transparent px-4 pt-10 pb-5">
        <span className="text-xs font-semibold text-white/80">
          {hasMoney ? `${amount} MON · ` : ""}gone in {TIMERS[timerIdx].label}
        </span>
        <button
          disabled={busy}
          onClick={() => (presetTo ? void send() : setStep("sendTo"))}
          className="flex items-center gap-1.5 rounded-full bg-whizz py-3 pr-4 pl-5 text-base font-extrabold text-black shadow-lg active:scale-95 disabled:opacity-60"
        >
          {busy ? "Sending…" : presetTo ? `Send to @${presetTo}` : "Send To"}
          <Icon.Send size={20} />
        </button>
      </div>
      {error && step === "edit" && (
        <p className="absolute inset-x-4 bottom-20 rounded-xl bg-black/80 px-3 py-2 text-center text-sm font-semibold text-[#ff6b81]">{error}</p>
      )}

      {moneyOpen && (
        <div className="absolute inset-0 flex items-end bg-black/50" onClick={() => setMoneyOpen(false)}>
          <div className="safe-bottom w-full rounded-t-3xl bg-neutral-900 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />
            <h3 className="text-lg font-extrabold">Put money in this snap</h3>
            <p className="mt-1 text-sm text-white/55">They hold to unwrap it. If they don&apos;t open it in time, it comes back to you.</p>
            <div className="mt-4 grid grid-cols-4 gap-2">
              {AMOUNTS.map((a) => (
                <button
                  key={a}
                  onClick={() => {
                    setAmount(a);
                    setMoneyOpen(false);
                  }}
                  className={`rounded-2xl py-3 text-sm font-extrabold ${amount === a ? "bg-whizz text-black" : "bg-white/10"}`}
                >
                  {a === "0" ? "None" : a}
                </button>
              ))}
            </div>
            <p className="mt-3 text-center text-xs text-white/40">Amounts in MON</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** The "Send To" list: pick a friend (or type any @username), then send. */
function SendTo({
  friends,
  to,
  amount,
  busy,
  error,
  onPick,
  onBack,
  onSend,
}: {
  friends: FriendView[] | null;
  to: string;
  amount: string;
  busy: boolean;
  error: string | null;
  onPick: (name: string) => void;
  onBack: () => void;
  onSend: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.replace(/^@/, "");
  const shown = useMemo(() => (friends ?? []).filter((f) => f.name.includes(q)), [friends, q]);
  const typedIsNew = /^[a-z0-9_]{3,20}$/.test(q) && !shown.some((f) => f.name === q);

  return (
    <div className="absolute inset-0 flex flex-col bg-black">
      <div className="safe-top flex items-center gap-2 px-2 pt-2">
        <button onClick={onBack} aria-label="Back" className="p-2">
          <Icon.Back size={26} />
        </button>
        <h2 className="text-xl font-extrabold">Send To…</h2>
      </div>
      <div className="px-4 py-2">
        <label className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2.5">
          <Icon.Search size={18} className="text-white/50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value.toLowerCase().replace(/[^a-z0-9_@]/g, ""))}
            placeholder="Search or type a username"
            autoCapitalize="none"
            autoCorrect="off"
            className="w-full bg-transparent outline-none placeholder:text-white/40"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto pb-28">
        {typedIsNew && <Row name={q} sub="Send to this username" selected={to === q} onClick={() => onPick(q)} />}
        <h3 className="px-4 pt-3 pb-1 text-xs font-extrabold tracking-wide text-white/50 uppercase">Friends</h3>
        {friends === null && <p className="px-4 py-3 text-sm text-white/40">Loading…</p>}
        {friends?.length === 0 && !typedIsNew && (
          <p className="px-4 py-3 text-sm text-white/40">No friends yet — type a username above, or add friends first.</p>
        )}
        {shown.map((f) => (
          <Row
            key={f.address}
            name={f.name}
            sub={f.mutual ? "Friends" : "Added"}
            selected={to === f.name}
            onClick={() => onPick(f.name)}
          />
        ))}
      </div>

      {to && (
        <div className="safe-bottom absolute inset-x-0 bottom-0 bg-whizz text-black">
          {error && <p className="bg-black px-4 py-2 text-sm font-semibold text-[#ff6b81]">{error}</p>}
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1 truncate font-extrabold">
              @{to}
              {Number(amount) > 0 && <span className="font-semibold"> · {amount} MON</span>}
            </span>
            <button
              disabled={busy}
              onClick={onSend}
              aria-label="Send snap"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-black text-whizz active:scale-90 disabled:opacity-60"
            >
              <Icon.Send size={24} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ name, sub, selected, onClick }: { name: string; sub: string; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 px-4 py-2.5 text-left active:bg-white/5">
      <Avatar name={name} size={44} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-bold">{name}</span>
        <span className="block text-xs text-white/50">{sub}</span>
      </span>
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${
          selected ? "border-whizz bg-whizz text-black" : "border-white/30"
        }`}
      >
        {selected && <Icon.Check size={14} />}
      </span>
    </button>
  );
}

type Prepared = { recipient?: Address; key?: Hex | null; gas?: bigint; baseBytes: number; error?: string };

const payloadBytes = (hex: Hex) => (hex.length - 2) / 2;
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Everything a snap needs before it can be signed: the friend's address, their
 * encryption key, and a gas limit (Monad bills the limit, so we estimate it).
 * That's 2–3 network round trips — done in the background while composing.
 */
async function prepareSnap(
  account: PrivateKeyAccount,
  name: string,
  knownAddress: Address | undefined,
  value: bigint,
  imageHex: Hex,
): Promise<Prepared> {
  let recipient: Address | null | undefined;
  let key: Hex | null | undefined;
  try {
    recipient = knownAddress ?? (await addressForName(name));
    if (!recipient) return { baseBytes: 0, error: `No one called @${name} yet` };
    key = await getEncryptionKey(recipient);
    // Same shape as the real snap, minus the caption (added at send time).
    const sample = key ? await encryptSnap(key, "", hexToBytes(imageHex)) : imageHex;
    const baseBytes = payloadBytes(sample);
    try {
      const gas = await estimateWhizzGas({
        account,
        functionName: "sendSnap",
        args: [recipient, TIMERS[0].secs, "", sample], // the timer doesn't change the cost
        value,
      });
      return { recipient, key, gas, baseBytes };
    } catch (e) {
      // The contract said no (blocked, friends-only…) or the money isn't there: tell the user now.
      const reverted = e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError);
      if (/insufficient (funds|balance)/i.test(String(e))) {
        return { recipient, key, baseBytes, error: value > 0n ? "Not enough MON for this snap — tap your balance to add some" : friendlyError(e) };
      }
      if (reverted) return { recipient, key, baseBytes, error: friendlyError(e) };
      // Just a network hiccup — send anyway; writeWhizz will estimate itself.
      return { recipient, key, baseBytes };
    }
  } catch (e) {
    return { baseBytes: 0, error: friendlyError(e) };
  }
}
