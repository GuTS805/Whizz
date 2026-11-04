"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { parseEther, type PrivateKeyAccount } from "viem";

import { whizzAbi } from "@/lib/abi";
import { publicClient, WHIZZ_ADDRESS } from "@/lib/chain";
import { encryptionPublicKey } from "@/lib/crypto";
import { useWhizzEvents } from "@/lib/events";
import { estimateWhizzGas, friendlyError, warmUp, writeWhizz } from "@/lib/tx";
import { requestDrip, useBalance } from "@/lib/useBalance";
import { exportPrivateKey, hasAccount, importPrivateKey, loadOrCreateAccount, normalizePrivateKey } from "@/lib/wallet";
import { addressForName, getEncryptionKey } from "@/lib/whizz";

import { Camera } from "./Camera";
import { ChatList, ChatThread, type ChatPartner } from "./Chat";
import { Friends } from "./Friends";
import { Rain } from "./Rain";
import { SpeedPage } from "./Scoreboard";
import { Icon, TopBar } from "./ui";
import { Wallet } from "./Wallet";

type Tab = "rain" | "chat" | "camera" | "friends" | "speed";

/** Enough MON to register comfortably (the gas limit is reserved up front on Monad). */
const MIN_SIGNUP_BALANCE = parseEther("0.05");

/** The username is remembered on the phone so the app opens instantly; the chain is still checked. */
const NAME_KEY = "whizz:name";

/**
 * Create this device's wallet and top it up from the faucet — once. Sign-up
 * starts this as early as possible and later steps await the same promise.
 * Tops up whenever the wallet is LOW, not just empty: a wallet left over from an
 * earlier sign-up can hold a little MON that isn't enough (the server re-checks).
 */
let funding: { address: string; promise: Promise<PrivateKeyAccount> } | null = null;
function fundWallet(): Promise<PrivateKeyAccount> {
  const acc = loadOrCreateAccount();
  if (funding?.address === acc.address) return funding.promise;
  const promise = (async () => {
    const bal = await publicClient.getBalance({ address: acc.address });
    if (bal < MIN_SIGNUP_BALANCE) {
      const err = await requestDrip(acc.address);
      if (err) throw new Error(`Couldn't get gas: ${err}`);
    }
    return acc;
  })();
  const entry = { address: acc.address, promise };
  funding = entry;
  promise.catch(() => {
    if (funding === entry) funding = null; // failed → the next try starts fresh
  });
  return promise;
}

/** Older or restored wallets may not have published an encryption key yet — do it quietly. */
function ensureEncryptionKey(acc: PrivateKeyAccount) {
  void getEncryptionKey(acc.address)
    .then((key) =>
      key
        ? undefined
        : writeWhizz({
            account: acc,
            functionName: "setEncryptionKey",
            args: [encryptionPublicKey(exportPrivateKey()!)],
            label: "setEncryptionKey",
          }),
    )
    .catch(() => {});
}

type Claim = { name: string; state: "pending" | "done" };

export function WhizzApp() {
  const [account, setAccount] = useState<PrivateKeyAccount | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("camera");
  const [rainParam, setRainParam] = useState<bigint | null>(null);
  const [addParam, setAddParam] = useState<string | null>(null);
  const [snapTo, setSnapTo] = useState<string | null>(null);
  const [openChat, setOpenChat] = useState<ChatPartner | null>(null);
  const [chatDot, setChatDot] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [claim, setClaim] = useState<Claim | null>(null);
  const [signupError, setSignupError] = useState<{ name: string; error: string } | null>(null);
  const { balance, refresh } = useBalance(account?.address);

  // New message or snap for me while I'm on another tab → dot on the Chat tab.
  // (Not while Chat is open: you're already looking at it.)
  useWhizzEvents((logs) => {
    if (!account || tab === "chat") return;
    const me = account.address.toLowerCase();
    const forMe = logs.some(
      (l) =>
        (l.eventName === "MessageSent" || l.eventName === "SnapSent") &&
        String((l.args as { to: string }).to).toLowerCase() === me,
    );
    if (forMe) setChatDot(true);
  });

  // On first load: restore the burner wallet (if any) and its username.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rain = params.get("rain");
    const add = params.get("add")?.toLowerCase() ?? null;
    const boot = async () => {
      warmUp(); // prefetch gas price so the first snap is fast
      if (rain && /^\d+$/.test(rain)) {
        setRainParam(BigInt(rain));
        setTab("rain");
      } else if (add && /^[a-z0-9_]{3,20}$/.test(add)) {
        // Invite link (?add=name) → open Friends with the name filled in.
        setAddParam(add);
        setTab("friends");
      }
      if (hasAccount() && WHIZZ_ADDRESS) {
        const acc = loadOrCreateAccount();
        setAccount(acc);
        const remembered = localStorage.getItem(NAME_KEY);
        if (remembered) {
          // Open straight away with the remembered name; confirm it with the chain after.
          setName(remembered);
          setReady(true);
        }
        const n = await publicClient
          .readContract({ address: WHIZZ_ADDRESS, abi: whizzAbi, functionName: "nameOf", args: [acc.address] })
          .catch(() => null); // network trouble: trust what we remembered
        if (n !== null) {
          if (n) localStorage.setItem(NAME_KEY, n);
          else localStorage.removeItem(NAME_KEY);
          setName(n || null);
        }
        if (n) ensureEncryptionKey(acc);
      }
      setReady(true);
    };
    void boot();
  }, []);

  /**
   * Sign-up finishes INSTANTLY: we drop you into the camera and claim the
   * name on-chain in the background (the name was already checked as free).
   * If the claim fails, you land back on the username screen with the reason.
   */
  const signUp = (acc: PrivateKeyAccount, chosen: string) => {
    setAccount(acc);
    setName(chosen);
    setTab("camera");
    setClaim({ name: chosen, state: "pending" });
    void (async () => {
      try {
        await fundWallet();
        await writeWhizz({
          account: acc,
          functionName: "register",
          args: [chosen, encryptionPublicKey(exportPrivateKey()!)],
          label: "register",
        });
        localStorage.setItem(NAME_KEY, chosen);
        setClaim({ name: chosen, state: "done" });
        setTimeout(() => setClaim(null), 2000);
        void refresh();
      } catch (e) {
        setClaim(null);
        setName(null);
        setSignupError({ name: chosen, error: friendlyError(e) });
      }
    })();
  };

  if (!WHIZZ_ADDRESS) return <NotDeployed />;
  if (!ready) return <Splash />;
  if (!account || !name) {
    return (
      <Onboarding
        initialName={signupError?.name}
        initialError={signupError?.error}
        onSignUp={signUp}
        onRestored={(acc, n) => {
          localStorage.setItem(NAME_KEY, n);
          setAccount(acc);
          setName(n);
          ensureEncryptionKey(acc);
        }}
      />
    );
  }

  const goTab = (id: Tab) => {
    if (id !== "camera") setSnapTo(null); // leaving the camera clears a preset friend
    if (id === "chat") {
      setChatDot(false);
      if (tab === "chat") setOpenChat(null); // tapping Chat again goes back to the list
    }
    setTab(id);
  };
  const snapFriend = (friendName: string) => {
    setSnapTo(friendName);
    setTab("camera");
  };
  const openProfile = () => setWalletOpen(true);

  const titles: Record<Exclude<Tab, "camera">, string> = { rain: "Rain", chat: "Chat", friends: "Friends", speed: "Speed" };
  const showTopBar = tab !== "camera" && !(tab === "chat" && openChat);

  return (
    <main className="relative mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden bg-black text-white">
      {showTopBar && (
        <header className="safe-top z-20 bg-black">
          <TopBar
            name={name}
            title={titles[tab as Exclude<Tab, "camera">]}
            onProfile={openProfile}
            right={
              tab === "friends" ? undefined : (
                <button
                  onClick={() => goTab("friends")}
                  aria-label="Add friends"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10"
                >
                  <Icon.AddFriend size={18} />
                </button>
              )
            }
          />
        </header>
      )}

      <section className={`relative flex-1 overflow-hidden ${tab === "camera" ? "rounded-b-3xl" : ""}`}>
        {tab === "camera" && (
          <Camera
            account={account}
            name={name}
            balance={balance}
            presetTo={snapTo}
            onProfile={openProfile}
            onSpeed={() => goTab("speed")}
            onSent={(partner) => {
              // Like Snapchat: after sending, jump into that conversation.
              setSnapTo(null);
              setOpenChat(partner);
              setTab("chat");
            }}
          />
        )}
        {tab === "chat" &&
          (openChat ? (
            <ChatThread account={account} partner={openChat} onBack={() => setOpenChat(null)} onSnap={snapFriend} />
          ) : (
            <ChatList account={account} onOpen={setOpenChat} onSnap={snapFriend} />
          ))}
        {tab === "rain" && <Rain account={account} focusRainId={rainParam} />}
        {tab === "friends" && (
          <Friends
            account={account}
            myName={name}
            prefillAdd={addParam}
            onSnap={snapFriend}
            onChat={(partner) => {
              setOpenChat(partner);
              setTab("chat");
            }}
          />
        )}
        {tab === "speed" && <SpeedPage />}

        {/* Background name claim after sign-up. */}
        <AnimatePresence>
          {claim && (
            <motion.div
              initial={{ y: -40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -40, opacity: 0 }}
              className="safe-top pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center"
            >
              <span className="rounded-full bg-white px-4 py-2 text-sm font-bold text-black shadow-lg">
                {claim.state === "pending" ? `Claiming @${claim.name} on Monad…` : `You're @${claim.name} ⚡`}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <nav className="safe-bottom z-20 grid grid-cols-5 bg-black">
        {(
          [
            ["rain", "Rain", Icon.Rain],
            ["chat", "Chat", Icon.Chat],
            ["camera", "Camera", Icon.Camera],
            ["friends", "Friends", Icon.Friends],
            ["speed", "Speed", Icon.Bolt],
          ] as const
        ).map(([id, label, TabIcon]) => (
          <button
            key={id}
            onClick={() => goTab(id)}
            aria-label={label}
            className={`relative flex flex-col items-center gap-0.5 pt-2.5 pb-2 text-[10px] font-semibold ${
              tab === id ? "text-white" : "text-white/45"
            }`}
          >
            <TabIcon size={24} filled={tab === id && id !== "camera" && id !== "friends"} />
            {label}
            {id === "chat" && chatDot && tab !== "chat" && (
              <span className="absolute top-1.5 right-[calc(50%-16px)] h-2.5 w-2.5 rounded-full bg-[#0fadff] ring-2 ring-black" aria-label="New messages" />
            )}
          </button>
        ))}
      </nav>

      {walletOpen && (
        <Wallet
          account={account}
          name={name}
          balance={balance}
          onRefresh={() => void refresh()}
          onClose={() => setWalletOpen(false)}
        />
      )}
    </main>
  );
}

// ─────────────────────────────── Sign-up ───────────────────────────────

type Availability = "idle" | "checking" | "free" | "taken" | "error";

function Onboarding({
  initialName,
  initialError,
  onSignUp,
  onRestored,
}: {
  initialName?: string;
  initialError?: string;
  onSignUp: (acc: PrivateKeyAccount, name: string) => void;
  onRestored: (acc: PrivateKeyAccount, name: string) => void;
}) {
  const [step, setStep] = useState<"welcome" | "username" | "restore">(initialName ? "username" : "welcome");
  const [input, setInput] = useState(initialName ?? "");
  const [availability, setAvailability] = useState<Availability>("idle");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const valid = /^[a-z0-9_]{3,20}$/.test(input);

  // Live "is this name free?" check (+ pre-estimate the sign-up gas) once typing pauses.
  useEffect(() => {
    if (!valid) return;
    let cancelled = false; // a slow answer for "abc" must not decide "abcd"
    const t = setTimeout(async () => {
      setAvailability("checking");
      try {
        const owner = await addressForName(input);
        if (cancelled) return;
        setAvailability(owner ? "taken" : "free");
        if (!owner) {
          // Cached inside estimateWhizzGas, so the background claim skips this round trip.
          void estimateWhizzGas({
            account: loadOrCreateAccount(),
            functionName: "register",
            args: [input, encryptionPublicKey(exportPrivateKey()!)],
          }).catch(() => {});
        }
      } catch {
        if (!cancelled) setAvailability("error");
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [input, valid]);

  if (step === "welcome") {
    return (
      <main className="safe-top safe-bottom mx-auto flex h-dvh w-full max-w-md flex-col bg-whizz text-black">
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <div className="flex h-28 w-28 items-center justify-center rounded-[2rem] bg-black text-whizz shadow-2xl">
            <Icon.Bolt size={64} filled />
          </div>
          <h1 className="text-5xl font-black tracking-tight">Whizz</h1>
          <p className="max-w-[16rem] text-center text-lg font-semibold text-black/70">Snap money to your friends. Faster than a blink.</p>
        </div>
        <div className="space-y-3 p-6">
          <button
            onClick={() => {
              // Create the wallet and fetch gas NOW, while they pick a name.
              void fundWallet().catch(() => {});
              setStep("username");
            }}
            className="w-full rounded-full bg-black py-4 text-lg font-extrabold text-white active:scale-[0.98]"
          >
            Sign up
          </button>
          <button
            onClick={() => setStep("restore")}
            className="w-full rounded-full bg-white/90 py-4 text-lg font-extrabold text-black active:scale-[0.98]"
          >
            Log in with a backup key
          </button>
          <p className="pt-1 text-center text-xs font-semibold text-black/60">Your wallet lives on this phone · Monad testnet</p>
        </div>
      </main>
    );
  }

  if (step === "restore") {
    return (
      <Restore
        onBack={() => setStep("welcome")}
        onRestored={onRestored}
        onNeedsName={() => {
          setNotice("Wallet restored ✓ Now pick a username.");
          setStep("username");
        }}
      />
    );
  }

  const status: { text: string; tone: "ok" | "bad" | "muted" } | null = !input
    ? null
    : !valid
      ? { text: "3–20 characters: a–z, 0–9 and _", tone: "muted" }
      : availability === "checking" || availability === "idle"
        ? { text: "Checking…", tone: "muted" }
        : availability === "taken"
          ? { text: `@${input} is taken`, tone: "bad" }
          : availability === "error"
            ? { text: "Couldn't check right now — you can still try", tone: "muted" }
            : { text: `@${input} is available`, tone: "ok" };
  const canContinue = valid && (availability === "free" || availability === "error");

  return (
    <main className="safe-top safe-bottom mx-auto flex h-dvh w-full max-w-md flex-col bg-black text-white">
      <div className="px-4 pt-3">
        <button onClick={() => setStep("welcome")} aria-label="Back" className="p-2 text-whizz">
          <Icon.Back size={26} />
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center px-8 pt-10 text-center">
        <h1 className="text-3xl font-black">Pick a username</h1>
        <p className="mt-2 text-white/60">It&apos;s how friends find you and send you snaps.</p>
        {notice && <p className="mt-3 text-sm font-semibold text-whizz">{notice}</p>}
        <label className="mt-10 w-full border-b-2 border-white/20 pb-2 text-left focus-within:border-whizz">
          <span className="text-xs font-bold tracking-wide text-white/50 uppercase">Username</span>
          <input
            autoFocus
            value={input}
            onChange={(e) => {
              setInput(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""));
              setAvailability("idle");
              setError(null);
            }}
            maxLength={20}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="mt-1 w-full bg-transparent text-2xl font-bold outline-none"
          />
        </label>
        {status && (
          <p
            className={`mt-3 flex items-center gap-1.5 self-start text-sm font-semibold ${
              status.tone === "ok" ? "text-[#18c37d]" : status.tone === "bad" ? "text-[#f23c57]" : "text-white/50"
            }`}
          >
            {status.tone === "ok" && <Icon.Check size={16} />}
            {status.text}
          </p>
        )}
        {error && <p className="mt-3 self-start text-left text-sm font-semibold text-[#f23c57]">{error}</p>}
      </div>
      <div className="p-6">
        <button
          disabled={!canContinue}
          onClick={() => onSignUp(loadOrCreateAccount(), input)}
          className="w-full rounded-full bg-whizz py-4 text-lg font-extrabold text-black active:scale-[0.98] disabled:opacity-30"
        >
          Continue
        </button>
      </div>
    </main>
  );
}

/** Bring back a backed-up wallet (from Profile → "Show private key"). */
function Restore({
  onBack,
  onRestored,
  onNeedsName,
}: {
  onBack: () => void;
  onRestored: (acc: PrivateKeyAccount, name: string) => void;
  onNeedsName: () => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    setError(null);
    const key = normalizePrivateKey(keyInput);
    if (!key) {
      setError("That doesn't look like a private key (64 hex characters).");
      return;
    }
    const current = exportPrivateKey();
    if (current && current !== key && !window.confirm("This replaces the wallet currently on this device. Continue?")) {
      return;
    }
    setBusy(true);
    try {
      const acc = importPrivateKey(key);
      const n = await publicClient.readContract({
        address: WHIZZ_ADDRESS!,
        abi: whizzAbi,
        functionName: "nameOf",
        args: [acc.address],
      });
      if (n) onRestored(acc, n); // already has a username → straight into the app
      else onNeedsName();
    } catch (e) {
      setError(friendlyError(e));
    }
    setBusy(false);
  };

  return (
    <main className="safe-top safe-bottom mx-auto flex h-dvh w-full max-w-md flex-col bg-black text-white">
      <div className="px-4 pt-3">
        <button onClick={onBack} aria-label="Back" className="p-2 text-whizz">
          <Icon.Back size={26} />
        </button>
      </div>
      <div className="flex flex-1 flex-col px-8 pt-10">
        <h1 className="text-center text-3xl font-black">Log in</h1>
        <p className="mt-2 text-center text-white/60">Paste the private key you backed up from Profile.</p>
        <textarea
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="0x…"
          rows={3}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="mt-8 rounded-2xl bg-white/10 p-4 font-mono text-sm outline-none focus:ring-2 focus:ring-whizz"
        />
        {error && <p className="mt-3 text-sm font-semibold text-[#f23c57]">{error}</p>}
      </div>
      <div className="p-6">
        <button
          disabled={!keyInput.trim() || busy}
          onClick={restore}
          className="w-full rounded-full bg-whizz py-4 text-lg font-extrabold text-black active:scale-[0.98] disabled:opacity-30"
        >
          {busy ? "Logging in…" : "Log in"}
        </button>
      </div>
    </main>
  );
}

function Splash() {
  return (
    <main className="flex h-dvh items-center justify-center bg-whizz">
      <div className="flex h-24 w-24 animate-pulse items-center justify-center rounded-[1.75rem] bg-black text-whizz">
        <Icon.Bolt size={56} filled />
      </div>
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
