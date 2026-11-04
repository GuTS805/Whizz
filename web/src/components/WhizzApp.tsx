"use client";

import { useEffect, useState } from "react";
import type { PrivateKeyAccount } from "viem";

import { WHIZZ_ADDRESS } from "@/lib/chain";
import { mon } from "@/lib/format";
import { friendlyError, warmUp, writeWhizz } from "@/lib/tx";
import { requestDrip, useBalance } from "@/lib/useBalance";
import { hasAccount, loadOrCreateAccount } from "@/lib/wallet";
import { publicClient } from "@/lib/chain";
import { whizzAbi } from "@/lib/abi";

import { Camera } from "./Camera";
import { Inbox } from "./Inbox";
import { Rain } from "./Rain";
import { Scoreboard } from "./Scoreboard";

type Tab = "camera" | "inbox" | "rain";

export function WhizzApp() {
  const [account, setAccount] = useState<PrivateKeyAccount | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("camera");
  const [rainParam, setRainParam] = useState<bigint | null>(null);
  const { balance, refresh } = useBalance(account?.address);

  // On first load: restore the burner wallet (if any) and its username.
  useEffect(() => {
    const rain = new URLSearchParams(window.location.search).get("rain");
    const boot = async () => {
      warmUp(); // prefetch gas price so the first snap is fast
      if (rain && /^\d+$/.test(rain)) {
        setRainParam(BigInt(rain));
        setTab("rain");
      }
      if (hasAccount() && WHIZZ_ADDRESS) {
        const acc = loadOrCreateAccount();
        setAccount(acc);
        const n = await publicClient
          .readContract({ address: WHIZZ_ADDRESS, abi: whizzAbi, functionName: "nameOf", args: [acc.address] })
          .catch(() => "");
        if (n) setName(n);
      }
      setReady(true);
    };
    void boot();
  }, []);

  if (!WHIZZ_ADDRESS) return <NotDeployed />;
  if (!ready) return <Splash />;
  if (!account || !name) {
    return (
      <Onboarding
        onDone={(acc, n) => {
          setAccount(acc);
          setName(n);
        }}
      />
    );
  }

  return (
    <main className="relative mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden bg-black text-white">
      <header className="z-20 flex items-center justify-between px-4 pt-3 pb-2">
        <div>
          <div className="text-2xl font-black tracking-tight text-whizz">Whizz</div>
          <div className="text-xs text-white/60">@{name}</div>
        </div>
        <div className="flex items-center gap-2">
          <Scoreboard />
          <button
            onClick={async () => {
              const err = await requestDrip(account.address);
              if (err) alert(err);
              void refresh();
            }}
            className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold"
            title="Top up gas"
          >
            {balance === null ? "…" : `${mon(balance, 3)} MON`}
          </button>
        </div>
      </header>

      <section className="relative flex-1 overflow-hidden">
        {tab === "camera" && <Camera account={account} onSent={() => setTab("inbox")} />}
        {tab === "inbox" && <Inbox account={account} />}
        {tab === "rain" && <Rain account={account} focusRainId={rainParam} />}
      </section>

      <nav className="z-20 grid grid-cols-3 border-t border-white/10 bg-black/90 pb-[env(safe-area-inset-bottom)]">
        {(
          [
            ["inbox", "💬", "Snaps"],
            ["camera", "📸", "Camera"],
            ["rain", "🌧️", "Rain"],
          ] as const
        ).map(([id, icon, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex flex-col items-center py-2.5 text-xs ${tab === id ? "text-whizz" : "text-white/50"}`}
          >
            <span className="text-xl">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
    </main>
  );
}

function Onboarding({ onDone }: { onDone: (acc: PrivateKeyAccount, name: string) => void }) {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[a-z0-9_]{3,20}$/.test(input);

  const go = async () => {
    setError(null);
    try {
      // 1. Create a wallet right here in the browser — no app, no seed phrase.
      const acc = loadOrCreateAccount();
      // 2. Get a little gas money from our faucet route.
      setStatus("Getting you some gas ⛽");
      const bal = await publicClient.getBalance({ address: acc.address });
      if (bal === 0n) {
        const err = await requestDrip(acc.address);
        if (err) throw new Error(err);
      }
      // 3. Claim the username on-chain.
      setStatus("Claiming your name on Monad ⚡");
      await writeWhizz({ account: acc, functionName: "setName", args: [input], label: "setName" });
      onDone(acc, input);
    } catch (e) {
      setError(friendlyError(e));
      setStatus(null);
    }
  };

  return (
    <main className="mx-auto flex h-dvh w-full max-w-md flex-col justify-center gap-6 bg-black px-6 text-white">
      <div>
        <h1 className="text-6xl font-black tracking-tight text-whizz">Whizz</h1>
        <p className="mt-2 text-lg text-white/70">Snap money to your friends. Faster than a blink.</p>
      </div>
      <label className="flex items-center rounded-2xl bg-white/10 px-4 py-3 text-lg">
        <span className="text-white/50">@</span>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value.toLowerCase())}
          placeholder="pick a username"
          maxLength={20}
          className="ml-1 flex-1 bg-transparent outline-none"
        />
      </label>
      <button
        disabled={!valid || status !== null}
        onClick={go}
        className="rounded-2xl bg-whizz py-4 text-lg font-bold text-black disabled:opacity-40"
      >
        {status ?? "Let's go ⚡"}
      </button>
      {error && <p className="text-center text-sm text-red-400">{error}</p>}
      <p className="text-center text-xs text-white/40">A wallet is created on this device. Testnet only.</p>
    </main>
  );
}

function Splash() {
  return (
    <main className="flex h-dvh items-center justify-center bg-black">
      <div className="animate-pulse text-5xl font-black text-whizz">Whizz</div>
    </main>
  );
}

function NotDeployed() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-black p-8 text-center text-white">
      <div className="text-4xl font-black text-whizz">Whizz</div>
      <p className="text-white/70">Contract not deployed yet.</p>
      <code className="rounded bg-white/10 px-3 py-2 text-sm">cd contracts && npm run deploy:testnet</code>
    </main>
  );
}
