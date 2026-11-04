"use client";

import { bytesToHex, type Hex } from "viem";

import { BADGE_TEXT, supportsCanvasFilters, timeLabel, type Overlays } from "./filters";

/**
 * The photo travels inside the transaction, and every byte costs gas
 * (~16 gas per byte of calldata + ~8 per byte of event log). So we shrink it
 * to a small JPEG: ~200px and under MAX_BYTES (a 9KB photo measured ~425k gas;
 * 5KB keeps a snap around ~250k). Snap-sized photos are
 * meant to be glanced at, not printed.
 */
const MAX_SIDE = 200;
const MAX_BYTES = 5_000;

export async function captureFrame(
  video: HTMLVideoElement,
  mirror: boolean,
  look: { filter: string; overlays: Overlays } = { filter: "none", overlays: { time: false, badge: false } },
): Promise<{ hex: Hex; url: string }> {
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
  // Same CSS filter as the live preview, baked into the pixels.
  if (look.filter !== "none" && supportsCanvasFilters()) ctx.filter = look.filter;
  ctx.drawImage(video, 0, 0, w, h);
  ctx.filter = "none";
  ctx.setTransform(1, 0, 0, 1, 0, 0); // overlays must not be mirrored
  drawOverlays(ctx, w, h, look.overlays);

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

/** Time stamp (bottom-left) and event badge (top), sized relative to the photo. */
function drawOverlays(ctx: CanvasRenderingContext2D, w: number, h: number, overlays: Overlays) {
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = Math.max(2, w * 0.02);
  if (overlays.time) {
    ctx.font = `900 ${Math.round(w * 0.16)}px system-ui, sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.fillText(timeLabel(), w * 0.05, h * 0.88);
  }
  if (overlays.badge) {
    const size = Math.round(w * 0.065);
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    const textW = ctx.measureText(BADGE_TEXT).width;
    const padX = size * 0.7;
    const boxW = textW + padX * 2;
    const boxH = size * 1.9;
    const x = (w - boxW) / 2;
    const y = h * 0.06;
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#836ef9";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, boxW, boxH, boxH / 2);
    else ctx.rect(x, y, boxW, boxH); // older browsers: square corners
    ctx.fill();
    ctx.fillStyle = "#000000";
    ctx.fillText(BADGE_TEXT, w / 2, y + boxH / 2);
  }
}

/** Bytes from the on-chain event → an <img>-ready URL. */
export function hexToImageUrl(hex: Hex): string | null {
  if (!hex || hex === "0x") return null;
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}
