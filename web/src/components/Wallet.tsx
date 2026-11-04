"use client";

import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { formatEther, getAddress, isAddress, parseEther, type PrivateKeyAccount } from "viem";

import { explorerAddress, explorerTx } from "@/lib/chain";
import { copyText } from "@/lib/clipboard";
import { mon } from "@/lib/format";
import { friendlyError, maxSendable, sendMon } from "@/lib/tx";
import { requestDrip } from "@/lib/useBalance";
import { exportPrivateKey } from "@/lib/wallet";
import { addressForName } from "@/lib/whizz";

/**
 * Wallet screen: see your address, receive MON, withdraw to any wallet
 * (or a Whizz @username), and back up the key so the wallet survives a
 * reinstall or a new phone.
 */
export function Wallet({
  account,
  name,
  balance,
  onRefresh,
  onClose,
}: {
  account: PrivateKeyAccount;
  name: string;
  balance: bigint | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black text-white">
      <div className="pt-safe-6 mx-auto max-w-md space-y-4 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-whizz">Your wallet</h2>
            <p className="text-xs text-white/50">@{name}</p>
          </div>
          <button onClick={onClose} className="text-2xl" aria-label="Close wallet">
            ✕
          </button>
        </div>

        <BalanceCard account={account} balance={balance} onRefresh={onRefresh} />
        <Receive address={account.address} />
        <Withdraw account={account} balance={balance} onSent={onRefresh} />
        <Backup />
      </div>
    </div>
  );
}

function BalanceCard({ account, balance, onRefresh }: { account: PrivateKeyAccount; balance: bigint | null; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <section className="rounded-3xl bg-gradient-to-br from-whizz/30 to-white/5 p-5">
      <div className="text-xs text-white/60">Balance</div>
      <div className="text-4xl font-black">{balance === null ? "…" : mon(balance)} <span className="text-lg">MON</span></div>
      <div className="mt-1 text-[11px] text-white/40">Monad testnet</div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const err = await requestDrip(account.address);
          setMsg(err ?? "Gas added ⛽");
          onRefresh();
          setBusy(false);
        }}
        className="mt-3 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {busy ? "…" : "Get gas ⛽"}
      </button>
      {msg && <p className="mt-2 text-xs text-white/70">{msg}</p>}
    </section>
  );
}

function Receive({ address }: { address: `0x${string}` }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="rounded-3xl bg-white/5 p-5">
      <h3 className="font-bold">Receive</h3>
      <p className="mb-3 text-xs text-white/50">Send MON to this address from any wallet or faucet.</p>
      <div className="mx-auto w-fit rounded-2xl bg-white p-3">
        <QRCodeSVG value={address} size={170} />
      </div>
      <p className="mt-3 rounded-xl bg-black/40 p-3 text-center font-mono text-xs break-all">{address}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          onClick={async () => {
            setCopied(await copyText(address));
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-xl bg-whizz py-2.5 text-sm font-bold text-black"
        >
          {copied ? "Copied ✓" : "Copy address"}
        </button>
        <a
          href={explorerAddress(address)}
          target="_blank"
          rel="noreferrer"
          className="rounded-xl bg-white/10 py-2.5 text-center text-sm font-semibold"
        >
          View on explorer
        </a>
      </div>
    </section>
  );
}

function Withdraw({ account, balance, onSent }: { account: PrivateKeyAccount; balance: bigint | null; onSent: () => void }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentHash, setSentHash] = useState<string | null>(null);

  const fillMax = async () => {
    if (balance === null) return;
    setError(null);
    const max = await maxSendable(balance);
    if (max === 0n) setError("Not enough MON to cover the network fee.");
    else setAmount(formatEther(max));
  };

  /** "0x…" address or a Whizz "@username" → checksummed address. */
  const resolveRecipient = async (raw: string): Promise<`0x${string}`> => {
    const input = raw.trim();
    if (isAddress(input, { strict: false })) return getAddress(input);
    const name = input.replace(/^@/, "").toLowerCase();
    if (/^[a-z0-9_]{3,20}$/.test(name)) {
      const addr = await addressForName(name);
      if (addr) return addr;
      throw new Error(`No Whizz user called @${name}`);
    }
    throw new Error("Enter a 0x… address or a @username");
  };

  const send = async () => {
    setError(null);
    setSentHash(null);
    try {
      if (balance === null) throw new Error("Balance still loading");
      setBusy("Checking…");
      const recipient = await resolveRecipient(to);
      if (recipient.toLowerCase() === account.address.toLowerCase()) throw new Error("That's your own wallet");

      let value: bigint;
      try {
        value = parseEther(amount.trim());
      } catch {
        throw new Error("Enter a valid amount, e.g. 0.05");
      }
      if (value <= 0n) throw new Error("Amount must be more than 0");
      const max = await maxSendable(balance);
      if (value > max) throw new Error(`You can send at most ${mon(max, 6)} MON (the rest pays the network fee)`);

      setBusy("Sending ⚡");
      const receipt = await sendMon({ account, to: recipient, value });
      setSentHash(receipt.transactionHash);
      setAmount("");
      onSent();
    } catch (e) {
      setError(friendlyError(e));
    }
    setBusy(null);
  };

  return (
    <section className="rounded-3xl bg-white/5 p-5">
      <h3 className="font-bold">Withdraw</h3>
      <p className="mb-3 text-xs text-white/50">Move MON to your own wallet (e.g. MetaMask) or a Whizz friend.</p>
      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="0x… address or @username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="w-full rounded-xl bg-black/40 px-3 py-3 font-mono text-sm outline-none"
      />
      <div className="mt-2 flex gap-2">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (MON)"
          inputMode="decimal"
          className="min-w-0 flex-1 rounded-xl bg-black/40 px-3 py-3 outline-none"
        />
        <button onClick={fillMax} className="rounded-xl bg-white/10 px-4 text-sm font-semibold">
          Max
        </button>
      </div>
      <button
        disabled={busy !== null || !to.trim() || !amount.trim()}
        onClick={send}
        className="mt-3 w-full rounded-xl bg-whizz py-3 font-bold text-black disabled:opacity-40"
      >
        {busy ?? "Send"}
      </button>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {sentHash && (
        <p className="mt-2 text-sm text-whizz">
          Sent ✓{" "}
          <a href={explorerTx(sentHash)} target="_blank" rel="noreferrer" className="underline">
            view transaction
          </a>
        </p>
      )}
    </section>
  );
}

function Backup() {
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reveal = () => {
    const ok = window.confirm(
      "Your private key controls this wallet.\n\nAnyone who sees it can take your MON. Never share it or screenshot it in public.\n\nShow it now?",
    );
    if (ok) setKey(exportPrivateKey());
  };

  return (
    <section className="rounded-3xl border border-red-500/30 bg-red-500/5 p-5">
      <h3 className="font-bold">Back up your wallet</h3>
      <p className="mt-1 text-xs text-white/60">
        Your wallet lives only on this device. Uninstalling Whizz or clearing its data deletes it. Save your
        private key somewhere safe to restore it later.
      </p>
      {key === null ? (
        <button onClick={reveal} className="mt-3 rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold">
          Show private key
        </button>
      ) : (
        <>
          <p className="mt-3 rounded-xl bg-black/60 p-3 font-mono text-xs break-all select-all">{key}</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              onClick={async () => {
                setCopied(await copyText(key));
                setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded-xl bg-white/10 py-2.5 text-sm font-semibold"
            >
              {copied ? "Copied ✓" : "Copy key"}
            </button>
            <button onClick={() => setKey(null)} className="rounded-xl bg-white/10 py-2.5 text-sm font-semibold">
              Hide
            </button>
          </div>
        </>
      )}
    </section>
  );
}
