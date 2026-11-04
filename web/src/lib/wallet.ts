"use client";

import { nonceManager, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const STORAGE_KEY = "whizz:burner-key";

/**
 * Burner wallet: a private key generated in the browser and kept in
 * localStorage. No popups, no seed phrase — perfect for a demo, but it
 * should only ever hold small testnet amounts.
 *
 * `nonceManager` lets us fire several transactions back-to-back (hold-to-unwrap
 * sends one per block) without waiting — viem hands out nonces 5, 6, 7…
 * locally instead of asking the chain each time.
 */
export function loadOrCreateAccount(): PrivateKeyAccount {
  let key = localStorage.getItem(STORAGE_KEY) as `0x${string}` | null;
  if (!key) {
    key = generatePrivateKey();
    localStorage.setItem(STORAGE_KEY, key);
  }
  return privateKeyToAccount(key, { nonceManager });
}

export function hasAccount(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}
