"use client";

/**
 * Camera filters. Each filter is a CSS filter string, used twice:
 *  - live preview: as `style.filter` on the <video>
 *  - the captured photo: as `ctx.filter` on the canvas (baked into the JPEG,
 *    so the recipient sees exactly what you saw)
 */
export type FilterId = "normal" | "vivid" | "noir" | "sepia" | "cool" | "warm" | "monad";

export const FILTERS: { id: FilterId; label: string; css: string }[] = [
  { id: "normal", label: "Normal", css: "none" },
  { id: "vivid", label: "Vivid", css: "saturate(1.6) contrast(1.1)" },
  { id: "noir", label: "Noir", css: "grayscale(1) contrast(1.35) brightness(0.95)" },
  { id: "sepia", label: "Sepia", css: "sepia(0.85) contrast(1.05)" },
  { id: "cool", label: "Cool", css: "saturate(1.15) hue-rotate(-15deg) brightness(1.04)" },
  { id: "warm", label: "Warm", css: "sepia(0.3) saturate(1.35) brightness(1.04)" },
  { id: "monad", label: "Monad 💜", css: "sepia(0.45) hue-rotate(215deg) saturate(1.7) contrast(1.05)" },
];

export const filterCss = (id: FilterId) => FILTERS.find((f) => f.id === id)?.css ?? "none";

/** Overlays drawn on top of the photo. */
export type Overlays = { time: boolean; badge: boolean };
export const BADGE_TEXT = "Monad Blitz Mumbai ⚡";

/**
 * Can this browser apply filters to a canvas? (Chrome/Android yes; Safari
 * since v18.) If not, we hide filters rather than show a preview that the
 * photo wouldn't match.
 */
let canvasFilterSupport: boolean | null = null;
export function supportsCanvasFilters(): boolean {
  if (canvasFilterSupport === null) {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx || !("filter" in ctx)) {
      canvasFilterSupport = false;
    } else {
      ctx.filter = "grayscale(1)";
      canvasFilterSupport = ctx.filter === "grayscale(1)";
    }
  }
  return canvasFilterSupport;
}

export function timeLabel(d = new Date()): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
