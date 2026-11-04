"use client";

import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";
import type { Address, PrivateKeyAccount } from "viem";

import { copyText } from "@/lib/clipboard";
import { useWhizzEvents } from "@/lib/events";
import { friendlyError, writeWhizz } from "@/lib/tx";
import { addressForName, getFriendsOnly, listBlocked, listFriendRequests, listFriends, type FriendView } from "@/lib/whizz";

import { Avatar, Icon } from "./ui";

/**
 * Friends: add people by username or QR, accept "added you" requests, and
 * jump straight to snapping a friend. The list lives on-chain, so restoring
 * your wallet on another phone brings your friends with it.
 */
export function Friends({
  account,
  myName,
  prefillAdd,
  onSnap,
  onChat,
}: {
  account: PrivateKeyAccount;
  myName: string;
  prefillAdd: string | null;
  onSnap: (name: string) => void;
  onChat: (partner: { address: Address; name: string }) => void;
}) {
  const [friends, setFriends] = useState<FriendView[] | null>(null);
  const [requests, setRequests] = useState<FriendView[]>([]);
  const [showCode, setShowCode] = useState(false);

  const load = useCallback(async () => {
    const f = await listFriends(account.address);
    const r = await listFriendRequests(
      account.address,
      f.map((x) => x.address),
    );
    // Friends you can snap first: mutual ones on top, then alphabetical.
    f.sort((a, b) => Number(b.mutual) - Number(a.mutual) || a.name.localeCompare(b.name));
    setFriends(f);
    setRequests(r);
  }, [account.address]);

  useEffect(() => {
    const t = setTimeout(() => void load().catch(() => setFriends([])), 0);
    return () => clearTimeout(t);
  }, [load]);

  // Someone added/removed me (or I changed my list on another device) → refresh.
  useWhizzEvents((logs) => {
    const me = account.address.toLowerCase();
    const touchesMe = logs.some((l) => {
      if (l.eventName !== "FriendAdded" && l.eventName !== "FriendRemoved") return false;
      const a = l.args as { user: Address; friend: Address };
      return a.user.toLowerCase() === me || a.friend.toLowerCase() === me;
    });
    if (touchesMe) void load();
  });

  return (
    <div className="absolute inset-0 overflow-y-auto pb-8">
      <AddFriend account={account} myName={myName} prefill={prefillAdd} onAdded={load} />

      <button onClick={() => setShowCode(true)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/5">
        <Avatar name={myName} size={44} />
        <span className="min-w-0 flex-1">
          <span className="block font-bold">My add-me code</span>
          <span className="block text-xs text-white/50">Friends scan it to add {myName}</span>
        </span>
        <Icon.Send size={18} className="text-white/40" />
      </button>
      {showCode && <MyCode name={myName} onClose={() => setShowCode(false)} />}

      {requests.length > 0 && (
        <section>
          <SectionTitle>Added Me · {requests.length}</SectionTitle>
          <ul>
            {requests.map((r) => (
              <RequestRow key={r.address} account={account} person={r} onDone={load} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionTitle>My Friends{friends ? ` · ${friends.length}` : ""}</SectionTitle>
        {friends === null && <p className="px-4 py-2 text-sm text-white/40">Loading…</p>}
        {friends?.length === 0 && <p className="px-4 py-2 text-sm text-white/40">No friends yet — add someone by their username above.</p>}
        <ul>
          {friends?.map((f) => (
            <FriendRow key={f.address} account={account} friend={f} onSnap={onSnap} onChat={onChat} onRemoved={load} />
          ))}
        </ul>
      </section>

      <Privacy account={account} />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="px-4 pt-5 pb-1.5 text-xs font-extrabold tracking-wide text-white/50 uppercase">{children}</h2>;
}

/** Anti-spam controls: friends-only mode and the block list. Both enforced by the contract. */
function Privacy({ account }: { account: PrivateKeyAccount }) {
  const [friendsOnly, setFriendsOnlyState] = useState<boolean | null>(null);
  const [blockedUsers, setBlockedUsers] = useState<{ address: Address; name: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [fo, bl] = await Promise.all([getFriendsOnly(account.address), listBlocked(account.address)]);
    setFriendsOnlyState(fo);
    setBlockedUsers(bl);
  }, [account.address]);

  useEffect(() => {
    const t = setTimeout(() => void load().catch(() => {}), 0);
    return () => clearTimeout(t);
  }, [load]);

  useWhizzEvents((logs) => {
    const me = account.address.toLowerCase();
    if (logs.some((l) => (l.eventName === "BlockSet" || l.eventName === "FriendsOnlySet") && (l.args as { user: Address }).user.toLowerCase() === me)) {
      void load();
    }
  });

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(friendlyError(e));
    }
    setBusy(null);
  };

  return (
    <section>
      <SectionTitle>Privacy</SectionTitle>
      <div className="px-4">
        <label className="flex items-center justify-between gap-3 py-1">
          <span>
            <span className="block font-bold">Friends only</span>
            <span className="block text-xs text-white/50">Only people you&apos;ve added can snap you</span>
          </span>
          <button
            role="switch"
            aria-checked={friendsOnly === true}
            disabled={friendsOnly === null || busy !== null}
            onClick={() =>
              run("friendsOnly", () =>
                writeWhizz({ account, functionName: "setFriendsOnly", args: [!friendsOnly], label: "setFriendsOnly" }),
              )
            }
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${friendsOnly ? "bg-whizz" : "bg-white/20"}`}
          >
            <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${friendsOnly ? "left-6" : "left-1"}`} />
          </button>
        </label>

        <h3 className="mt-4 text-sm font-bold">Blocked · {blockedUsers.length}</h3>
        {blockedUsers.length === 0 && <p className="text-xs text-white/50">No one. Block people from a snap or an &quot;added you&quot; request.</p>}
        <ul className="mt-1">
          {blockedUsers.map((b) => (
            <li key={b.address} className="flex items-center gap-3 py-1.5">
              <Avatar name={b.name} size={32} />
              <span className="flex-1 text-sm font-semibold">{b.name}</span>
              <button
                disabled={busy !== null}
                onClick={() =>
                  run(b.address, () => writeWhizz({ account, functionName: "setBlocked", args: [b.address, false], label: "unblock" }))
                }
                className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold disabled:opacity-50"
              >
                {busy === b.address ? "…" : "Unblock"}
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="mt-2 text-xs text-[#ff6b81]">{error}</p>}
      </div>
    </section>
  );
}

function AddFriend({
  account,
  myName,
  prefill,
  onAdded,
}: {
  account: PrivateKeyAccount;
  myName: string;
  prefill: string | null;
  onAdded: () => Promise<void>;
}) {
  const [input, setInput] = useState(prefill ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const name = input.replace(/^@/, "").toLowerCase();
  const valid = /^[a-z0-9_]{3,20}$/.test(name);

  const add = async () => {
    setMsg(null);
    if (name === myName) {
      setMsg({ ok: false, text: "That's you 😄" });
      return;
    }
    setBusy(true);
    try {
      const addr = await addressForName(name);
      if (!addr) throw new Error(`No Whizz user called @${name}`);
      await writeWhizz({ account, functionName: "addFriend", args: [addr], label: "addFriend" });
      setMsg({ ok: true, text: `Added ${name}` });
      setInput("");
      await onAdded();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    }
    setBusy(false);
  };

  return (
    <section className="px-4 pt-1 pb-2">
      <div className="flex gap-2">
        <label className="flex flex-1 items-center gap-2 rounded-full bg-white/10 px-4">
          <Icon.AddFriend size={18} className="shrink-0 text-white/50" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.toLowerCase().replace(/[^a-z0-9_@]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid && !busy) void add();
            }}
            placeholder="Add by username"
            autoCapitalize="none"
            autoCorrect="off"
            className="w-full bg-transparent py-2.5 outline-none placeholder:text-white/40"
          />
        </label>
        <button disabled={!valid || busy} onClick={add} className="rounded-full bg-whizz px-5 font-extrabold text-black disabled:opacity-30">
          {busy ? "…" : "Add"}
        </button>
      </div>
      {msg && <p className={`mt-2 px-1 text-sm font-semibold ${msg.ok ? "text-[#18c37d]" : "text-[#ff6b81]"}`}>{msg.text}</p>}
    </section>
  );
}

function RequestRow({ account, person, onDone }: { account: PrivateKeyAccount; person: FriendView; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="px-4 py-2">
      <div className="flex items-center gap-3">
        <Avatar name={person.name} size={44} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold">{person.name}</span>
          <span className="block text-xs text-white/50">Added you</span>
        </span>
        <button
          disabled={busy}
          onClick={async () => {
            if (!window.confirm(`Block ${person.name}? They won't be able to snap you or add you.`)) return;
            setBusy(true);
            setError(null);
            try {
              await writeWhizz({ account, functionName: "setBlocked", args: [person.address, true], label: "block" });
              await onDone();
            } catch (e) {
              setError(friendlyError(e));
            }
            setBusy(false);
          }}
          aria-label={`Block ${person.name}`}
          className="rounded-full p-2 text-white/50 disabled:opacity-50"
        >
          <Icon.Close size={18} />
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await writeWhizz({ account, functionName: "addFriend", args: [person.address], label: "addFriend" });
              await onDone();
            } catch (e) {
              setError(friendlyError(e));
            }
            setBusy(false);
          }}
          className="rounded-full bg-whizz px-4 py-1.5 text-sm font-extrabold text-black disabled:opacity-50"
        >
          {busy ? "…" : "+ Accept"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-[#ff6b81]">{error}</p>}
    </li>
  );
}

function FriendRow({
  account,
  friend,
  onSnap,
  onChat,
  onRemoved,
}: {
  account: PrivateKeyAccount;
  friend: FriendView;
  onSnap: (name: string) => void;
  onChat: (partner: { address: Address; name: string }) => void;
  onRemoved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="px-4 py-2">
      <div className="flex items-center gap-1">
        <Avatar name={friend.name} size={44} />
        <div className="min-w-0 flex-1 pl-2">
          <div className="truncate font-bold">{friend.name}</div>
          <div className="text-xs text-white/50">{friend.mutual ? "Friends" : "Waiting for them to add you back"}</div>
        </div>
        <button
          onClick={() => onChat({ address: friend.address, name: friend.name })}
          aria-label={`Chat with ${friend.name}`}
          className="rounded-full p-2 text-white/70"
        >
          <Icon.Chat size={21} />
        </button>
        <button onClick={() => onSnap(friend.name)} aria-label={`Snap ${friend.name}`} className="rounded-full p-2 text-white/70">
          <Icon.Camera size={21} />
        </button>
        <button
          disabled={busy}
          aria-label={`Remove ${friend.name}`}
          onClick={async () => {
            if (!window.confirm(`Remove ${friend.name} from your friends?`)) return;
            setBusy(true);
            setError(null);
            try {
              await writeWhizz({ account, functionName: "removeFriend", args: [friend.address], label: "removeFriend" });
              await onRemoved();
            } catch (e) {
              setError(friendlyError(e));
            }
            setBusy(false);
          }}
          className="rounded-full p-2 text-white/40 disabled:opacity-50"
        >
          {busy ? "…" : <Icon.Close size={18} />}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-[#ff6b81]">{error}</p>}
    </li>
  );
}

function MyCode({ name, onClose }: { name: string; onClose: () => void }) {
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLink(`${window.location.origin}/?add=${name}`), 0);
    return () => clearTimeout(t);
  }, [name]);

  return (
    <div className="pt-safe-6 fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-whizz p-6 text-black" onClick={onClose}>
      {link && (
        <div className="rounded-[2rem] bg-white p-5 shadow-2xl">
          <QRCodeSVG value={link} size={220} />
        </div>
      )}
      <div className="text-center">
        <h2 className="text-3xl font-black">{name}</h2>
        <p className="font-semibold text-black/60">Scan to add me on Whizz</p>
      </div>
      <button
        onClick={async (e) => {
          e.stopPropagation();
          setCopied(await copyText(link));
          setTimeout(() => setCopied(false), 1500);
        }}
        className="rounded-full bg-black px-6 py-3 font-extrabold text-white"
      >
        {copied ? "Copied ✓" : "Copy invite link"}
      </button>
      <p className="text-xs font-semibold text-black/50">tap anywhere to close</p>
    </div>
  );
}
