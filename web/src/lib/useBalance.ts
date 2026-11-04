"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { publicClient } from "./chain";

/** Live MON balance, refreshed every 2s and on demand. */
export function useBalance(address: Address | undefined) {
  const [balance, setBalance] = useState<bigint | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      setBalance(await publicClient.getBalance({ address }));
    } catch {
      /* keep last value */
    }
  }, [address]);

  useEffect(() => {
    if (!address) return;
    const first = setTimeout(refresh, 0);
    const id = setInterval(refresh, 2000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [address, refresh]);

  return { balance, refresh };
}

/** Ask our server route to top up a fresh burner wallet with gas money. */
export async function requestDrip(address: Address): Promise<string | null> {
  const res = await fetch("/api/drip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  if (res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? "Drip failed";
}
