"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { parseEther, type PrivateKeyAccount } from "viem";

import { mon, nowSec, sleep, timeLeft } from "@/lib/format";
import { hexToImageUrl } from "@/lib/image";
import { friendlyError, writeWhizz } from "@/lib/tx";
import { getSnapContent, type SnapView } from "@/lib/whizz";

/**
 * HOLD-TO-UNWRAP — the core "why Monad" feature.
 *
 * While your finger is down we send one `unwrap` transaction per ~block
 * (TICK_MS). Each tick releases 1/TICKS of the money. The progress bar only
 * moves when a tick is CONFIRMED on-chain — so every bump you see is a real
 * Monad block landing, not an animation.
 */
const TICKS = 8n;
const TICK_MS = 400; // ≈ Monad block time
const MAX_IN_FLIGHT = 3; // how many unconfirmed ticks we allow at once

const REACTIONS = [
  { id: 1, emoji: "🔥", value: parseEther("0.001") },
  { id: 2, emoji: "💀", value: parseEther("0.002") },
  { id: 3, emoji: "🫶", value: parseEther("0.005") },
] as const;

export function SnapViewer({
  account,
  snap,
  senderName,
  onClose,
}: {
  account: PrivateKeyAccount;
  snap: SnapView;
  senderName: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<{ caption: string; url: string | null } | null>(null);
  const [claimed, setClaimed] = useState(snap.claimed);
  const [holding, setHolding] = useState(false);
  const [ticksDone, setTicksDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [floaters, setFloaters] = useState<{ key: number; text: string }[]>([]);
  const [now, setNow] = useState(nowSec);

  const holdingRef = useRef(false);
  const confirmedRef = useRef(snap.claimed);
  const reservedRef = useRef(0n); // amount in unconfirmed ticks
  const inFlightRef = useRef(0);

  const total = snap.total;
  const hasMoney = total > 0n;
  const tickSize = hasMoney ? (total + TICKS - 1n) / TICKS : 0n; // round up
  const progress = hasMoney ? Number((claimed * 1000n) / total) / 1000 : 1;
  const done = hasMoney && claimed >= total;

  // Load the photo + caption from the on-chain event.
  useEffect(() => {
    let url: string | null = null;
    getSnapContent(snap)
      .then((c) => {
        url = hexToImageUrl(c.image);
        setContent({ caption: c.caption, url });
      })
      .catch(() => setContent({ caption: "", url: null }));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [snap]);

  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), 1000);
    return () => clearInterval(id);
  }, []);

  const floatIdRef = useRef(0);
  const float = (text: string) => {
    const key = ++floatIdRef.current;
    setFloaters((f) => [...f, { key, text }]);
    setTimeout(() => setFloaters((f) => f.filter((x) => x.key !== key)), 900);
  };

  // The pump: runs while the finger is down, firing one tick per block.
  const pump = async () => {
    while (holdingRef.current) {
      const remaining = total - confirmedRef.current - reservedRef.current;
      if (remaining <= 0n) break;
      if (inFlightRef.current >= MAX_IN_FLIGHT) {
        await sleep(50);
        continue;
      }
      const amount = remaining < tickSize ? remaining : tickSize;
      reservedRef.current += amount;
      inFlightRef.current += 1;

      writeWhizz({ account, functionName: "unwrap", args: [snap.id, amount], label: "unwrap" })
        .then(() => {
          confirmedRef.current += amount;
          setClaimed(confirmedRef.current);
          setTicksDone((t) => t + 1);
          float(`+${mon(amount)}`);
        })
        .catch((e) => {
          holdingRef.current = false;
          setHolding(false);
          setError(friendlyError(e));
        })
        .finally(() => {
          reservedRef.current -= amount;
          inFlightRef.current -= 1;
        });

      await sleep(TICK_MS);
    }
  };

  const start = () => {
    if (holdingRef.current || done || !hasMoney) return;
    setError(null);
    holdingRef.current = true;
    setHolding(true);
    void pump();
  };
  const stop = () => {
    holdingRef.current = false;
    setHolding(false);
  };

  const react = async (r: (typeof REACTIONS)[number]) => {
    float(r.emoji);
    try {
      await writeWhizz({ account, functionName: "react", args: [snap.id, r.id], value: r.value, label: "react" });
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  // Photo reveals as money is unwrapped (blur → sharp). Money-less snaps show right away.
  const blurPx = hasMoney ? Math.round(24 * (1 - progress)) : 0;

  return (
    <div className="absolute inset-0 flex flex-col bg-black select-none">
      <div
        className="relative flex-1 touch-none overflow-hidden"
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onContextMenu={(e) => e.preventDefault()}
      >
        {content?.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- on-chain bytes as blob URL
          <img
            src={content.url}
            alt="Snap"
            draggable={false}
            className="h-full w-full object-cover transition-[filter] duration-300"
            style={{ filter: `blur(${blurPx}px)` }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-white/40">{content ? "No photo" : "Loading snap…"}</div>
        )}

        {content?.caption && (
          <div className="absolute inset-x-0 bottom-28 bg-black/50 px-4 py-2 text-center text-lg">{content.caption}</div>
        )}

        <button onClick={onClose} className="absolute top-4 left-4 rounded-full bg-black/60 px-3 py-1 text-xl" onPointerDown={(e) => e.stopPropagation()}>
          ✕
        </button>
        <div className="absolute top-4 right-4 rounded-full bg-black/60 px-3 py-1 text-xs">
          @{senderName} · poof in {timeLeft(snap.expiresAt, now)}
        </div>

        {hasMoney && (
          <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 text-center">
            <motion.div
              key={claimed.toString()}
              initial={{ scale: 1.25 }}
              animate={{ scale: 1 }}
              className="text-5xl font-black drop-shadow-lg"
            >
              {mon(claimed)} <span className="text-2xl">/ {mon(total)} MON</span>
            </motion.div>
            <div className="mt-4 h-3 overflow-hidden rounded-full bg-white/20">
              <motion.div className="h-full bg-whizz" animate={{ width: `${progress * 100}%` }} transition={{ type: "spring", stiffness: 300, damping: 30 }} />
            </div>
            <p className="mt-3 text-sm text-white/80">
              {done
                ? "Unwrapped! 🎉"
                : holding
                  ? `Unwrapping… ${ticksDone} block${ticksDone === 1 ? "" : "s"} confirmed ⚡`
                  : "Hold to unwrap 👆"}
            </p>
          </div>
        )}

        <AnimatePresence>
          {floaters.map((f) => (
            <motion.div
              key={f.key}
              initial={{ opacity: 1, y: 0 }}
              animate={{ opacity: 0, y: -120 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9 }}
              className="pointer-events-none absolute right-8 bottom-40 text-2xl font-black text-whizz"
            >
              {f.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="flex items-center justify-between gap-3 p-4">
        <div className="flex gap-2">
          {REACTIONS.map((r) => (
            <button key={r.id} onClick={() => react(r)} className="rounded-full bg-white/10 px-3 py-2 text-2xl active:scale-90">
              {r.emoji}
            </button>
          ))}
        </div>
        <span className="text-xs text-white/50">reactions tip @{senderName}</span>
      </div>
      {error && <p className="px-4 pb-3 text-sm text-red-400">{error}</p>}
    </div>
  );
}
