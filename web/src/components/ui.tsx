"use client";

/**
 * Shared look: line icons (instead of emoji buttons), round avatars, and
 * Snapchat-style status colours. Kept in one place so every screen matches.
 */

/** Status colours used across chats: snap / snap with money / text chat. */
export const STATUS = {
  snap: "#f23c57",
  money: "#836ef9",
  chat: "#0fadff",
} as const;

const AVATAR_COLORS = ["#836ef9", "#0fadff", "#f23c57", "#18c37d", "#ff9f1c", "#e05cd8", "#00b8a9"];

/** A circle with the first letter, coloured by the name (same name → same colour everywhere). */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-black text-white"
      style={{ width: size, height: size, fontSize: size * 0.42, background: AVATAR_COLORS[h % AVATAR_COLORS.length] }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** "now", "5m", "3h", "2d" — like a chat list. */
export function timeAgo(unixSec: number, nowSec: number): string {
  const s = Math.max(0, nowSec - unixSec);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

type IconProps = { size?: number; className?: string; filled?: boolean };

function Svg({ size = 24, className, children, filled }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Chat: (p: IconProps) => (
    <Svg {...p}>
      <path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z" />
    </Svg>
  ),
  Camera: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.4-2h6.6l1.4 2h1.8A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
      <circle cx="12" cy="13" r="3.6" fill="none" />
    </Svg>
  ),
  Friends: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.5A6.5 6.5 0 0 1 21.5 20" fill="none" />
    </Svg>
  ),
  Rain: (p: IconProps) => (
    <Svg {...p}>
      <path d="M7 15a4.5 4.5 0 1 1 1-8.9A5.5 5.5 0 0 1 18.5 8 3.5 3.5 0 0 1 18 15z" />
      <path d="M8 18.5 7 21M12 18.5 11 21M16 18.5 15 21" fill="none" />
    </Svg>
  ),
  Bolt: (p: IconProps) => (
    <Svg {...p}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </Svg>
  ),
  Flip: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5" />
    </Svg>
  ),
  Close: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  ),
  Back: (p: IconProps) => (
    <Svg {...p}>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  ),
  Send: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </Svg>
  ),
  Search: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </Svg>
  ),
  AddFriend: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="10" cy="8" r="3.5" />
      <path d="M3.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" />
    </Svg>
  ),
  NewChat: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V12" />
      <path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L13 14l-4 1 1-4z" />
    </Svg>
  ),
  Text: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 6V4.5h14V6M12 4.5V20M9 20h6" />
    </Svg>
  ),
  Timer: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2.5M9.5 2.5h5" />
    </Svg>
  ),
  Money: (p: IconProps) => (
    <Svg {...p}>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 9.5v5M18 9.5v5" />
    </Svg>
  ),
  Clock: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  ),
  Tag: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z" />
      <circle cx="7.5" cy="7.5" r="1.3" />
    </Svg>
  ),
  Check: (p: IconProps) => (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  ),
  More: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" />
    </Svg>
  ),
};

/**
 * Chat-list status marks, Snapchat style: a filled square = new for you,
 * an outlined square = you've seen it, a filled arrow = you sent it,
 * an outlined arrow = they opened it.
 */
export function StatusMark({ kind, color }: { kind: "new" | "seen" | "sent" | "opened"; color: string }) {
  if (kind === "new" || kind === "seen") {
    return (
      <span
        className="inline-block h-3 w-3 shrink-0 rounded-[3px]"
        style={kind === "new" ? { background: color } : { border: `2px solid ${color}` }}
        aria-hidden
      />
    );
  }
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden className="shrink-0">
      <path
        d="M1.5 1.5 12 6 1.5 10.5 4 6z"
        fill={kind === "sent" ? color : "none"}
        stroke={color}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Top bar used by every tab except the camera: avatar · title · actions. */
export function TopBar({
  name,
  title,
  onProfile,
  right,
}: {
  name: string;
  title: string;
  onProfile: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex h-14 items-center gap-2 px-3">
      <div className="flex min-w-[80px] items-center">
        <button onClick={onProfile} aria-label="Profile and wallet" className="rounded-full">
          <Avatar name={name} size={36} />
        </button>
      </div>
      <h1 className="flex-1 text-center text-xl font-extrabold tracking-tight">{title}</h1>
      <div className="flex min-w-[80px] items-center justify-end gap-2">{right}</div>
    </div>
  );
}

export function RoundButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white">
      {children}
    </button>
  );
}
