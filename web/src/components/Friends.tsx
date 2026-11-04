"use client";

import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";
import type { Address, PrivateKeyAccount } from "viem";

import { copyText } from "@/lib/clipboard";
import { useWhizzEvents } from "@/lib/events";
import { friendlyError, writeWhizz } from "@/lib/tx";
import { addressForName, getFriendsOnly, listBlocked, listFriendRequests, listFriends, type FriendView } from "@/lib/whizz";

/**
 * Friends: add people by @username or QR, accept "added you" requests, and
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
    <div className="absolute inset-0 space-y-5 overflow-y-auto p-4">
      <AddFriend account={account} myName={myName} prefill={prefillAdd} onAdded={load} />

      <button onClick={() => setShowCode(true)} className="w-full rounded-2xl bg-white/5 py-3 text-sm font-semibold">
        📇 Show my add-me code
      </button>
      {showCode && <MyCode name={myName} onClose={() => setShowCode(false)} />}

      {requests.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-white/60">Added you ({requests.length})</h2>
          <ul className="space-y-2">
            {requests.map((r) => (
              <RequestRow key={r.address} account={account} person={r} onDone={load} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-white/60">
          Friends{friends ? ` (${friends.length})` : ""}
        </h2>
        {friends === null && <p className="text-white/50">Loading…</p>}
        {friends?.length === 0 && <p className="text-white/50">No friends yet. Add someone by their @username ☝️</p>}
        <ul className="space-y-2">
          {friends?.map((f) => (
            <FriendRow key={f.address} account={account} friend={f} onSnap={onSnap} onChat={onChat} onRemoved={load} />
          ))}
        </ul>
      </section>

      <Privacy account={account} />
    </div>
  );
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
    <section className="rounded-3xl bg-white/5 p-4">
      <h2 className="font-bold">Privacy</h2>
      <label className="mt-3 flex items-center justify-between gap-3">
        <span>
          <span className="block text-sm font-semibold">Friends only</span>
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

      <h3 className="mt-4 text-sm font-semibold">Blocked ({blockedUsers.length})</h3>
      {blockedUsers.length === 0 && <p className="text-xs text-white/50">No one. Block people from a snap or an &quot;added you&quot; request.</p>}
      <ul className="mt-2 space-y-2">
        {blockedUsers.map((b) => (
          <li key={b.address} className="flex items-center justify-between rounded-xl bg-black/30 px-3 py-2">
            <span className="text-sm">@{b.name}</span>
            <button
              disabled={busy !== null}
              onClick={() =>
                run(b.address, () =>
                  writeWhizz({ account, functionName: "setBlocked", args: [b.address, false], label: "unblock" }),
                )
              }
              className="rounded-full bg-white/10 px-3 py-1 text-xs disabled:opacity-50"
            >
              {busy === b.address ? "…" : "Unblock"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
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
      setMsg({ ok: true, text: `Added @${name} 🤝` });
      setInput("");
      await onAdded();
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(e) });
    }
    setBusy(false);
  };

  return (
    <section className="rounded-3xl bg-gradient-to-br from-whizz/30 to-white/5 p-4">
      <h2 className="text-xl font-black">Add a friend</h2>
      <div className="mt-3 flex gap-2">
        <label className="flex flex-1 items-center rounded-xl bg-black/40 px-3">
          <span className="text-white/50">@</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.toLowerCase().replace(/[^a-z0-9_@]/g, ""))}
            placeholder="username"
            autoCapitalize="none"
            autoCorrect="off"
            className="w-full bg-transparent py-3 pl-1 outline-none"
          />
        </label>
        <button disabled={!valid || busy} onClick={add} className="rounded-xl bg-whizz px-5 font-bold text-black disabled:opacity-40">
          {busy ? "…" : "Add"}
        </button>
      </div>
      {msg && <p className={`mt-2 text-sm ${msg.ok ? "text-whizz" : "text-red-400"}`}>{msg.text}</p>}
    </section>
  );
}

function RequestRow({ account, person, onDone }: { account: PrivateKeyAccount; person: FriendView; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="rounded-2xl bg-whizz/10 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">@{person.name}</span>
        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={async () => {
              if (!window.confirm(`Block @${person.name}? They won't be able to snap you or add you.`)) return;
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
            className="rounded-full bg-white/10 px-3 py-1.5 text-sm text-red-300 disabled:opacity-50"
          >
            Block
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
            className="rounded-full bg-whizz px-4 py-1.5 text-sm font-bold text-black disabled:opacity-50"
          >
            {busy ? "…" : "Add back"}
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
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
    <li className="rounded-2xl bg-white/5 p-3">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-whizz/20 font-black text-whizz">
          {friend.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">@{friend.name}</div>
          <div className="text-xs text-white/50">{friend.mutual ? "Friends 🤝" : "Waiting for them to add you back"}</div>
        </div>
        <button
          onClick={() => onChat({ address: friend.address, name: friend.name })}
          aria-label={`Chat with @${friend.name}`}
          className="rounded-full bg-white/10 px-3 py-1.5 text-sm"
        >
          💬
        </button>
        <button onClick={() => onSnap(friend.name)} className="rounded-full bg-whizz px-3 py-1.5 text-sm font-bold text-black">
          📸
        </button>
        <button
          disabled={busy}
          aria-label={`Remove @${friend.name}`}
          onClick={async () => {
            if (!window.confirm(`Remove @${friend.name} from your friends?`)) return;
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
          className="rounded-full bg-white/10 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {busy ? "…" : "✕"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
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
    <div className="pt-safe-6 fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/95 p-6" onClick={onClose}>
      <h2 className="text-3xl font-black text-whizz">@{name}</h2>
      <p className="text-white/60">Friends scan this to add you</p>
      {link && (
        <div className="rounded-3xl bg-white p-4">
          <QRCodeSVG value={link} size={240} />
        </div>
      )}
      <button
        onClick={async (e) => {
          e.stopPropagation();
          setCopied(await copyText(link));
          setTimeout(() => setCopied(false), 1500);
        }}
        className="rounded-xl bg-whizz px-5 py-2.5 font-bold text-black"
      >
        {copied ? "Copied ✓" : "Copy invite link"}
      </button>
      <p className="text-xs text-white/40">tap anywhere to close</p>
    </div>
  );
}
