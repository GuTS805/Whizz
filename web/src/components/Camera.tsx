"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseEther, type Hex, type PrivateKeyAccount } from "viem";

import { captureFrame } from "@/lib/image";
import { friendlyError, writeWhizz } from "@/lib/tx";
import { addressForName } from "@/lib/whizz";

const AMOUNTS = ["0", "0.01", "0.05", "0.1"] as const;
const TIMERS = [
  { label: "2 min", secs: 120n },
  { label: "1 hour", secs: 3600n },
  { label: "24 h", secs: 86400n },
] as const;

export function Camera({ account, onSent }: { account: PrivateKeyAccount; onSent: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [camError, setCamError] = useState<string | null>(null);
  const [shot, setShot] = useState<{ hex: Hex; url: string } | null>(null);
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
    setShot(await captureFrame(v, facing === "user"));
  }, [facing]);

  if (shot) return <Compose account={account} shot={shot} onCancel={() => setShot(null)} onSent={onSent} />;

  return (
    <div className="absolute inset-0 bg-neutral-900">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`h-full w-full object-cover ${facing === "user" ? "-scale-x-100" : ""}`}
      />
      {(camError || !camSupported) && (
        <p className="absolute inset-x-6 top-1/3 text-center text-white/80">
          {camSupported ? camError : "Camera needs https on phones."}
        </p>
      )}
      <div className="absolute inset-x-0 bottom-6 flex items-center justify-center gap-10">
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
  );
}

function Compose({
  account,
  shot,
  onCancel,
  onSent,
}: {
  account: PrivateKeyAccount;
  shot: { hex: Hex; url: string };
  onCancel: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState("");
  const [caption, setCaption] = useState("");
  const [amount, setAmount] = useState<string>("0.01");
  const [timer, setTimer] = useState<bigint>(TIMERS[0].secs);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setError(null);
    try {
      setBusy("Finding @" + to);
      const recipient = await addressForName(to);
      if (!recipient) throw new Error(`No one called @${to} yet`);
      setBusy("Whizzing ⚡");
      await writeWhizz({
        account,
        functionName: "sendSnap",
        args: [recipient, timer, caption, shot.hex],
        value: parseEther(amount),
        label: "sendSnap",
      });
      onSent();
    } catch (e) {
      setError(friendlyError(e));
      setBusy(null);
    }
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
        <p className="text-center text-[11px] text-white/40">Photo ~{Math.round((shot.hex.length - 2) / 2 / 1024)} KB · goes fully on-chain</p>
      </div>
    </div>
  );
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
