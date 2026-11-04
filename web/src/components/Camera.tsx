"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BaseError,
  ContractFunctionRevertedError,
  hexToBytes,
  parseEther,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";

import { BADGE_TEXT, FILTERS, filterCss, supportsCanvasFilters, timeLabel, type FilterId, type Overlays } from "@/lib/filters";
import { captureFrame } from "@/lib/image";
import { outbox } from "@/lib/outbox";
import { estimateWhizzGas, friendlyError, writeWhizz } from "@/lib/tx";
import { encryptSnap } from "@/lib/crypto";
import { addressForName, getEncryptionKey, listFriends, type FriendView } from "@/lib/whizz";

const AMOUNTS = ["0", "0.01", "0.05", "0.1"] as const;
const TIMERS = [
  { label: "2 min", secs: 120n },
  { label: "1 hour", secs: 3600n },
  { label: "24 h", secs: 86400n },
] as const;

export function Camera({
  account,
  presetTo,
  onSent,
}: {
  account: PrivateKeyAccount;
  /** Friend chosen from the Friends tab ("📸 Snap"), pre-selected as recipient. */
  presetTo: string | null;
  /** Called with the recipient, so the app can open that conversation. */
  onSent: (to: { address: Address; name: string }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [camError, setCamError] = useState<string | null>(null);
  const [shot, setShot] = useState<{ hex: Hex; url: string } | null>(null);
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
      .catch(() => setCamError("Camera blocked. Allow camera access in your browser."));
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
        <div className="pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 rounded-full bg-whizz px-4 py-1.5 text-sm font-extrabold whitespace-nowrap text-black">
          {BADGE_TEXT}
        </div>
      )}
      {overlays.time && (
        <div className="pointer-events-none absolute bottom-48 left-5 text-6xl font-black text-white drop-shadow-lg">
          {clock}
        </div>
      )}

      {presetTo && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1.5 text-sm">
          Snapping <span className="font-bold text-whizz">@{presetTo}</span>
        </div>
      )}
      {(camError || !camSupported) && (
        <p className="absolute inset-x-6 top-1/3 text-center text-white/80">
          {camSupported ? camError : "Camera needs https on phones."}
        </p>
      )}

      <div className="absolute top-4 right-3 flex flex-col gap-2">
        <ToggleButton on={overlays.time} label="Time stamp" onClick={() => setOverlays((o) => ({ ...o, time: !o.time }))}>
          🕒
        </ToggleButton>
        <ToggleButton on={overlays.badge} label="Event badge" onClick={() => setOverlays((o) => ({ ...o, badge: !o.badge }))}>
          🏷️
        </ToggleButton>
      </div>

      <div className="absolute inset-x-0 bottom-4 space-y-4">
        {filtersAvailable && (
          <div className="flex gap-2 overflow-x-auto px-4 pb-1">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-sm backdrop-blur ${
                  filter === f.id ? "bg-white font-bold text-black" : "bg-black/50 text-white"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center justify-center gap-10">
          <div className="w-12" />
          <button
            onClick={snap}
            aria-label="Take snap"
            className="h-20 w-20 rounded-full border-[6px] border-white bg-white/20 active:scale-95"
          />
          <button
            onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}
            aria-label="Flip camera"
            className="h-12 w-12 rounded-full bg-black/50 text-xl"
          >
            🔄
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleButton({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      className={`h-11 w-11 rounded-full text-xl backdrop-blur ${on ? "bg-whizz" : "bg-black/50"}`}
    >
      {children}
    </button>
  );
}

function Compose({
  account,
  shot,
  presetTo,
  onCancel,
  onSent,
}: {
  account: PrivateKeyAccount;
  shot: { hex: Hex; url: string };
  presetTo: string | null;
  onCancel: () => void;
  onSent: (to: { address: Address; name: string }) => void;
}) {
  const [to, setTo] = useState(presetTo ?? "");
  const [friends, setFriends] = useState<FriendView[]>([]);

  // Friends as one-tap recipients (mutual friends first).
  useEffect(() => {
    let cancelled = false;
    listFriends(account.address)
      .then((f) => {
        if (!cancelled) setFriends(f.sort((a, b) => Number(b.mutual) - Number(a.mutual) || a.name.localeCompare(b.name)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [account.address]);
  const [caption, setCaption] = useState("");
  const [amount, setAmount] = useState<string>("0.01");
  const [timer, setTimer] = useState<bigint>(TIMERS[0].secs);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Do the slow lookups WHILE the user is still composing, so Send is instant.
  const prepRef = useRef<{ key: string; promise: Promise<Prepared> } | null>(null);
  const prepare = useCallback(
    (name: string, value: bigint) => {
      const k = `${name}|${value}`; // the estimate also checks you can afford the amount
      if (prepRef.current?.key !== k) {
        const known = friends.find((f) => f.name === name)?.address;
        prepRef.current = { key: k, promise: prepareSnap(account, name, known, value, shot.hex) };
      }
      return prepRef.current.promise;
    },
    [account, friends, shot.hex],
  );
  useEffect(() => {
    if (to.length < 3) return;
    // Wait for typing to pause; friend chips set the full name at once.
    const t = setTimeout(() => void prepare(to, parseEther(amount)), 300);
    return () => clearTimeout(t);
  }, [to, amount, prepare]);

  const send = async () => {
    setError(null);
    setBusy("Whizzing ⚡");
    const value = parseEther(amount);
    let prep = await prepare(to, value);
    if (prep.error) {
      // It may have been fixed since (e.g. you just got gas) — check once more.
      prepRef.current = null;
      prep = await prepare(to, value);
    }
    if (prep.error || !prep.recipient) {
      setError(prep.error ?? `No one called @${to} yet`);
      setBusy(null);
      return;
    }
    // Private snap: encrypt photo + caption to the recipient's key, so the
    // chain only stores ciphertext. (Every Whizz sign-up publishes a key.)
    if (!prep.key && !window.confirm(`@${to} hasn't enabled private snaps yet. Send this snap unencrypted (anyone could view it)?`)) {
      setBusy(null);
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
    // Don't wait for Monad — open the chat now; it shows the snap as "Sending ⚡".
    onSent({ address: recipient, name: to });
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-black">
      <div className="relative flex-1 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- local blob URL */}
        <img src={shot.url} alt="Your snap" className="h-full w-full object-cover" />
        {Number(amount) > 0 && (
          <div className="absolute top-4 right-4 rotate-6 rounded-2xl bg-whizz px-4 py-2 text-xl font-black text-black shadow-lg">
            💸 {amount} MON
          </div>
        )}
        <input
          value={caption}
          onChange={(e) => setCaption(e.target.value.slice(0, 80))}
          placeholder="Add a caption…"
          className="absolute inset-x-0 bottom-6 bg-black/50 px-4 py-2 text-center text-lg outline-none"
        />
        <button onClick={onCancel} className="absolute top-4 left-4 rounded-full bg-black/60 px-3 py-1 text-xl">
          ✕
        </button>
      </div>

      <div className="space-y-3 p-4">
        <Chips label="Money" options={AMOUNTS.map((a) => ({ id: a, text: a === "0" ? "None" : `${a}` }))} value={amount} onChange={setAmount} />
        <Chips
          label="Poof in"
          options={TIMERS.map((t) => ({ id: t.secs.toString(), text: t.label }))}
          value={timer.toString()}
          onChange={(v) => setTimer(BigInt(v))}
        />
        {friends.length > 0 && (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            {friends.map((f) => (
              <button
                key={f.address}
                onClick={() => setTo(f.name)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-sm ${to === f.name ? "bg-whizz font-bold text-black" : "bg-white/10"}`}
              >
                @{f.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <label className="flex flex-1 items-center rounded-xl bg-white/10 px-3">
            <span className="text-white/50">@</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="friend"
              className="w-full bg-transparent py-3 pl-1 outline-none"
            />
          </label>
          <button
            disabled={to.length < 3 || busy !== null}
            onClick={send}
            className="rounded-xl bg-whizz px-5 font-bold text-black disabled:opacity-40"
          >
            {busy ?? "Send ⚡"}
          </button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <p className="text-center text-[11px] text-white/40">🔒 Encrypted for the recipient · ~{Math.round((shot.hex.length - 2) / 2 / 1024)} KB on-chain</p>
      </div>
    </div>
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
        return { recipient, key, baseBytes, error: value > 0n ? "Not enough MON for this snap 💸 — tap 👛" : friendlyError(e) };
      }
      if (reverted) return { recipient, key, baseBytes, error: friendlyError(e) };
      // Just a network hiccup — send anyway; writeWhizz will estimate itself.
      return { recipient, key, baseBytes };
    }
  } catch (e) {
    return { baseBytes: 0, error: friendlyError(e) };
  }
}

function Chips({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; text: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-xs text-white/50">{label}</span>
      <div className="flex flex-1 gap-2">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={`flex-1 rounded-full py-1.5 text-sm ${value === o.id ? "bg-white font-bold text-black" : "bg-white/10"}`}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}
