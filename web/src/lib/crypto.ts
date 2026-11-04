"use client";

import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes, type Hex } from "viem";

/**
 * Private snaps (ECIES). A snap's photo + caption are encrypted to the
 * recipient's wallet public key before they go on-chain, so the chain only
 * stores ciphertext that just the recipient can open.
 *
 *   one-time key pair  ──ECDH──▶  shared secret (only sender & recipient can compute)
 *   HKDF-SHA256(secret)  ──▶  AES-256-GCM key  ──▶  encrypt [caption + photo]
 *
 * Wire format: 0x01 | one-time public key (65) | iv (12) | ciphertext + GCM tag
 * Curve math: @noble/curves (audited, also used by viem). AES/HKDF: WebCrypto.
 */
const VERSION = 0x01; // plain JPEGs start with 0xFF, so the formats can't be confused
const EPHEMERAL_PUBKEY_LEN = 65;
const IV_LEN = 12;
const GCM_TAG_LEN = 16;
const HEADER_LEN = 1 + EPHEMERAL_PUBKEY_LEN + IV_LEN;
const INFO = new TextEncoder().encode("whizz-snap-v1");

async function aesKey(sharedSecret: Uint8Array, ephemeralPub: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", sharedSecret as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: ephemeralPub as BufferSource, info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** [caption length (2 bytes)] [caption UTF-8] [photo bytes] */
function pack(caption: string, image: Uint8Array): Uint8Array {
  const c = new TextEncoder().encode(caption);
  if (c.length > 0xffff) throw new Error("Caption too long");
  const out = new Uint8Array(2 + c.length + image.length);
  out[0] = c.length >> 8;
  out[1] = c.length & 0xff;
  out.set(c, 2);
  out.set(image, 2 + c.length);
  return out;
}

function unpack(data: Uint8Array): { caption: string; image: Uint8Array } {
  const len = (data[0] << 8) | data[1];
  return {
    caption: new TextDecoder().decode(data.subarray(2, 2 + len)),
    image: data.subarray(2 + len),
  };
}

/** The 64-byte public key we register on-chain (uncompressed, without the 0x04 prefix). */
export function encryptionPublicKey(privateKey: Hex): Hex {
  const full = secp256k1.getPublicKey(hexToBytes(privateKey), false); // 0x04 || x || y
  return bytesToHex(full.subarray(1));
}

export function isEncryptedSnap(blob: Uint8Array): boolean {
  return blob.length > HEADER_LEN + GCM_TAG_LEN && blob[0] === VERSION;
}

/** Encrypt caption + photo for `recipientKey` (64-byte key from the contract). */
export async function encryptSnap(recipientKey: Hex, caption: string, image: Uint8Array): Promise<Hex> {
  const pub = hexToBytes(recipientKey);
  if (pub.length !== 64) throw new Error("Recipient has no valid encryption key");
  const recipientPub = new Uint8Array(65);
  recipientPub[0] = 0x04;
  recipientPub.set(pub, 1);

  const ephemeralPriv = secp256k1.utils.randomPrivateKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, false);
  const shared = secp256k1.getSharedSecret(ephemeralPriv, recipientPub, true).subarray(1); // x-coordinate
  const key = await aesKey(shared, ephemeralPub, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pack(caption, image) as BufferSource),
  );

  const blob = new Uint8Array(HEADER_LEN + ciphertext.length);
  blob[0] = VERSION;
  blob.set(ephemeralPub, 1);
  blob.set(iv, 1 + EPHEMERAL_PUBKEY_LEN);
  blob.set(ciphertext, HEADER_LEN);
  return bytesToHex(blob);
}

/**
 * Chat messages are encrypted TWICE — once for the recipient, once for the
 * sender — so both people can read the conversation history.
 * Format: 0x02 | length of first copy (2 bytes) | copy for recipient | copy for sender
 */
const MESSAGE_VERSION = 0x02;

export async function encryptMessage(text: string, recipientKey: Hex, senderKey: Hex): Promise<Hex> {
  const empty = new Uint8Array(0);
  const forRecipient = hexToBytes(await encryptSnap(recipientKey, text, empty));
  const forSender = hexToBytes(await encryptSnap(senderKey, text, empty));
  const out = new Uint8Array(3 + forRecipient.length + forSender.length);
  out[0] = MESSAGE_VERSION;
  out[1] = forRecipient.length >> 8;
  out[2] = forRecipient.length & 0xff;
  out.set(forRecipient, 3);
  out.set(forSender, 3 + forRecipient.length);
  return bytesToHex(out);
}

/** Read a chat message with your own key (works whether you sent or received it). */
export async function decryptMessage(privateKey: Hex, blob: Uint8Array): Promise<string> {
  if (blob[0] !== MESSAGE_VERSION || blob.length < 3) throw new Error("Not a Whizz message");
  const firstLen = (blob[1] << 8) | blob[2];
  const copies = [blob.subarray(3, 3 + firstLen), blob.subarray(3 + firstLen)];
  for (const copy of copies) {
    try {
      return (await decryptSnap(privateKey, copy)).caption;
    } catch {
      // Not encrypted for this key — try the other copy.
    }
  }
  throw new Error("This message isn't for you");
}

/** Decrypt a snap with your own wallet key. Throws if it wasn't encrypted for you. */
export async function decryptSnap(privateKey: Hex, blob: Uint8Array): Promise<{ caption: string; image: Uint8Array }> {
  if (!isEncryptedSnap(blob)) throw new Error("Not an encrypted snap");
  const ephemeralPub = blob.subarray(1, 1 + EPHEMERAL_PUBKEY_LEN);
  const iv = blob.subarray(1 + EPHEMERAL_PUBKEY_LEN, HEADER_LEN);
  const ciphertext = blob.subarray(HEADER_LEN);

  const shared = secp256k1.getSharedSecret(hexToBytes(privateKey), ephemeralPub, true).subarray(1);
  const key = await aesKey(shared, ephemeralPub, "decrypt");
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource),
  );
  return unpack(plain);
}
