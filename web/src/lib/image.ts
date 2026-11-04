"use client";

import { bytesToHex, type Hex } from "viem";

/**
 * The photo travels inside the transaction, and every byte costs gas
 * (~16 gas per byte of calldata + ~8 per byte of event log). So we shrink it
 * to a small JPEG: ~200px and under MAX_BYTES (a 9KB photo measured ~425k gas;
 * 5KB keeps a snap around ~250k). Snap-sized photos are
 * meant to be glanced at, not printed.
 */
const MAX_SIDE = 200;
const MAX_BYTES = 5_000;

export async function captureFrame(video: HTMLVideoElement, mirror: boolean): Promise<{ hex: Hex; url: string }> {
  const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  if (mirror) {
    // Front camera preview is mirrored; flip the photo so it matches what you saw.
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);

  // Lower the quality step by step until it fits the byte budget.
  const qualities = [0.7, 0.55, 0.4, 0.3, 0.2];
  for (const [i, q] of qualities.entries()) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    const isLastTry = i === qualities.length - 1;
    if (blob && (blob.size <= MAX_BYTES || isLastTry)) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { hex: bytesToHex(bytes), url: URL.createObjectURL(blob) };
    }
  }
  throw new Error("Could not encode photo");
}

/** Bytes from the on-chain event → an <img>-ready URL. */
export function hexToImageUrl(hex: Hex): string | null {
  if (!hex || hex === "0x") return null;
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}
