"use client";

import { nonceManager, type Hex, type PrivateKeyAccount } from "viem";
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
  let key = localStorage.getItem(STORAGE_KEY) as Hex | null;
  if (!key) {
    key = generatePrivateKey();
    localStorage.setItem(STORAGE_KEY, key);
  }
  return privateKeyToAccount(key, { nonceManager });
}

export function hasAccount(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

/** The raw private key, for the user's own backup. Whoever has it controls the wallet. */
export function exportPrivateKey(): Hex | null {
  return localStorage.getItem(STORAGE_KEY) as Hex | null;
}

/**
 * Accepts a pasted private key in any common form (with/without 0x, stray
 * spaces) and returns it normalised, or null if it isn't a valid key.
 */
export function normalizePrivateKey(input: string): Hex | null {
  const hex = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const key = `0x${hex.toLowerCase()}` as Hex;
  try {
    privateKeyToAccount(key); // rejects out-of-range keys (e.g. all zeros)
    return key;
  } catch {
    return null;
  }
}

/** Replace this device's wallet with a backed-up one. */
export function importPrivateKey(key: Hex): PrivateKeyAccount {
  localStorage.setItem(STORAGE_KEY, key);
  return privateKeyToAccount(key, { nonceManager });
}
