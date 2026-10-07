// The aura behind a call avatar: one canvas, painted from the draw list
// src/lib/call-aura.ts computes for the phase, in the avatar's own colour
// and shape. The masks (the shape solid, blurred into a glow, and its thin
// outline) are built once per avatar and size; a frame is a few drawImage
// calls with scale and alpha, whatever the shape. Levels come in as
// getters read per frame, never as React state. See call-aura-design.md.
import { desktopResourceUrl } from "@/lib/live-events";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { EMBER_COLORS, type EmberColor } from "@/lib/mascot";
import { auraTicker } from "@/lib/aura-ticker";
import { botVoice, LevelSmoother, OwnerVoiceLevel, type BotVoiceLevel } from "@/lib/audio-level";
import {
  AMBER,
  AURA_LOOK,
  auraMode,
  auraScene,
  auraShapeFor,
  desaturate,
  frameLevel,
  imageTraits,
  liveRipples,
  clockStart,
  moodColor,
  parseHex,
  rgba,
  SHAPE_RADIUS,
  softLook,
  staticOpacity,
  vivid,
  type AuraLook,
  type AuraPhase,
  type AuraShape,
  type ImageTraits,
  type Rgb,
} from "@/lib/call-aura";
import { botAvatarProfile, type BotAvatarCrop } from "../../shared/bot-avatar";

/** The live voices a call screen hands its visuals. */
export interface CallSignals {
  bot: BotVoiceLevel;
  owner: OwnerVoiceLevel;
}

/** Signals that never move, for a screen with nothing to read yet. */
export function stillSignals(): CallSignals {
  return { bot: botVoice, owner: new OwnerVoiceLevel() };
}

// ── the avatar image, looked at once ─────────────────────────────────────

export interface SampledImage {
  traits: ImageTraits;
  image: HTMLImageElement;
}

const SAMPLE = 32;
const samples = new Map<string, Promise<SampledImage | null>>();

/** Loads the avatar and reads its colour, transparency and size off a 32 px
 *  canvas. Cached per URL; null when the image fails or the canvas refuses. */
export function sampleImage(url: string): Promise<SampledImage | null> {
  let pending = samples.get(url);
  if (!pending) {
    pending = new Promise<SampledImage | null>((resolve) => {
      if (typeof Image !== "function" || typeof document === "undefined") return resolve(null);
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = SAMPLE;
          canvas.height = SAMPLE;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(null);
          ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
          const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
          resolve({ traits: imageTraits(data, image.naturalWidth, image.naturalHeight), image });
        } catch {
          resolve(null);
        }
      };
      image.onerror = () => resolve(null);
      image.src = desktopResourceUrl(url);
    });
    samples.set(url, pending);
  }
  return pending;
}

export interface AvatarAura {
  shape: AuraShape;
  /** The avatar's own hue: the glow and the rings. */
  color: Rgb;
  /** What the mood floods the screen with while the bot talks: the avatar's
   *  hue when it is unmistakably not the owner's blue, else a warm one
   *  (call-aura.ts `moodColor`). */
  mood: Rgb;
  /** The sprite, for the silhouette mask. */
  image: HTMLImageElement | null;
  pixelArt: boolean;
  /** The call screen's presentation of the image (BotAvatar's prop). */
  presentation: { silhouette: boolean; pixelArt: boolean } | null;
  /** Whether a custom image (not the mascot) is on screen. */
  custom: boolean;
  crop: BotAvatarCrop;
}

/** What the aura and the mood need to know about a bot's avatar. */
export function useAvatarAura(bot: { color: EmberColor; avatarUrl?: string | null; avatarCrop?: unknown }): AvatarAura {
  const profile = botAvatarProfile(bot);
  const url = profile.avatarCrop !== "mascot" ? profile.avatarUrl : undefined;
  const [sampled, setSampled] = useState<SampledImage | null>(null);
  useEffect(() => {
    let live = true;
    setSampled(null);
    if (!url) return;
    void sampleImage(url).then((result) => {
      if (live) setSampled(result);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return useMemo(() => {
    const traits = sampled?.traits ?? null;
    const fallback = parseHex(EMBER_COLORS[bot.color] ?? EMBER_COLORS.orange) ?? AMBER;
    const color = traits?.color ? vivid(traits.color) : fallback;
    const mood = moodColor(color, traits?.warm ?? null);
    const silhouette = Boolean(url && traits?.transparent);
    return {
      shape: auraShapeFor(profile.avatarCrop, traits),
      color,
      mood,
      image: silhouette ? (sampled?.image ?? null) : null,
      pixelArt: Boolean(traits?.pixelArt),
      presentation: silhouette || traits?.pixelArt ? { silhouette, pixelArt: Boolean(traits?.pixelArt) } : null,
      custom: Boolean(url),
      crop: profile.avatarCrop,
    };
  }, [sampled, bot.color, url, profile.avatarCrop]);
}

// ── masks ────────────────────────────────────────────────────────────────

interface Masks {
  px: number;
  avatarPx: number;
  solid: HTMLCanvasElement;
  glow: HTMLCanvasElement;
  outline: HTMLCanvasElement;
  tinted: Map<string, HTMLCanvasElement>;
  scratch: HTMLCanvasElement;
}

function canvasOf(px: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  return canvas;
}

function roundedPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, side: number, radius: number) {
  const r = Math.min(radius, side / 2);
  const x = cx - side / 2, y = cy - side / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + side, y, x + side, y + side, r);
  ctx.arcTo(x + side, y + side, x, y + side, r);
  ctx.arcTo(x, y + side, x, y, r);
  ctx.arcTo(x, y, x + side, y, r);
  ctx.closePath();
}

/** Whether this canvas honours ctx.filter (Chromium, Safari 18). */
function supportsFilter(ctx: CanvasRenderingContext2D): boolean {
  if (!("filter" in ctx)) return false;
  const before = ctx.filter;
  ctx.filter = "blur(1px)";
  const ok = ctx.filter === "blur(1px)";
  ctx.filter = before;
  return ok;
}

function buildMasks(px: number, avatarPx: number, shape: AuraShape, image: HTMLImageElement | null, pixelArt: boolean): Masks | null {
  const solid = canvasOf(px);
  const s = solid.getContext("2d");
  if (!s) return null;
  const c = px / 2;
  if (shape === "silhouette" && image && image.naturalWidth && image.naturalHeight) {
    // contain-fit, as the <img> shows it
    const fit = Math.min(avatarPx / image.naturalWidth, avatarPx / image.naturalHeight);
    const w = image.naturalWidth * fit, h = image.naturalHeight * fit;
    s.imageSmoothingEnabled = !pixelArt;
    s.drawImage(image, c - w / 2, c - h / 2, w, h);
    s.globalCompositeOperation = "source-in";
    s.fillStyle = maskInk();
    s.fillRect(0, 0, px, px);
  } else {
    const radius = SHAPE_RADIUS[shape === "silhouette" ? "circle" : shape] * avatarPx;
    roundedPath(s, c, c, avatarPx, radius);
    s.fillStyle = maskInk();
    s.fill();
  }

  const glow = canvasOf(px);
  const g = glow.getContext("2d");
  if (!g) return null;
  const reach = avatarPx * 0.18;
  if (supportsFilter(g)) {
    g.filter = `blur(${reach.toFixed(1)}px)`;
    g.drawImage(solid, 0, 0);
    g.filter = "none";
  } else {
    // no canvas blur here: a stack of fading copies stands in
    for (let i = 0; i < 10; i += 1) {
      const scale = 1 + (i / 9) * 0.5;
      g.globalAlpha = 0.12 * (1 - i / 10);
      const side = px * scale;
      g.drawImage(solid, c - side / 2, c - side / 2, side, side);
    }
    g.globalAlpha = 1;
  }

  const outline = canvasOf(px);
  const o = outline.getContext("2d");
  if (!o) return null;
  const thickness = Math.max(2, avatarPx * 0.014);
  o.drawImage(solid, 0, 0);
  o.globalCompositeOperation = "destination-out";
  const inner = (px - 2 * thickness * (px / avatarPx)) / px;
  const side = px * inner;
  o.drawImage(solid, c - side / 2, c - side / 2, side, side);
  o.globalCompositeOperation = "source-over";

  return { px, avatarPx, solid, glow, outline, tinted: new Map(), scratch: canvasOf(px) };
}

/** The mask is read for its alpha only, so any opaque colour works; the ink
 *  token keeps it on the palette (canvas cannot take var()). */
function maskInk(): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue("--color-ink").trim() || "white";
  } catch {
    return "white";
  }
}

function tinted(masks: Masks, name: "glow" | "outline", color: Rgb): HTMLCanvasElement | null {
  const key = `${name}:${color.join(",")}`;
  let out = masks.tinted.get(key);
  if (!out) {
    out = canvasOf(masks.px);
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(masks[name], 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = rgba(color, 1);
    ctx.fillRect(0, 0, masks.px, masks.px);
    masks.tinted.set(key, out);
  }
  return out;
}

function paint(ctx: CanvasRenderingContext2D, masks: Masks, color: Rgb, ops: ReturnType<typeof auraScene>) {
  const { px } = masks;
  const c = px / 2;
  ctx.clearRect(0, 0, px, px);
  ctx.globalCompositeOperation = "lighter";
  for (const op of ops) {
    if (op.alpha <= 0.003) continue;
    const side = px * op.scale;
    if (op.kind === "arc") {
      const outline = tinted(masks, "outline", color);
      const scratch = masks.scratch.getContext("2d");
      if (!outline || !scratch) continue;
      scratch.globalCompositeOperation = "source-over";
      scratch.clearRect(0, 0, px, px);
      scratch.drawImage(outline, c - side / 2, c - side / 2, side, side);
      if (typeof scratch.createConicGradient === "function") {
        const gradient = scratch.createConicGradient(op.angle, c, c);
        const sweep = op.sweep / (Math.PI * 2);
        gradient.addColorStop(0, "rgba(255,255,255,0)");
        gradient.addColorStop(sweep / 2, "rgba(255,255,255,1)");
        gradient.addColorStop(sweep, "rgba(255,255,255,0)");
        gradient.addColorStop(1, "rgba(255,255,255,0)");
        scratch.globalCompositeOperation = "destination-in";
        scratch.fillStyle = gradient;
        scratch.fillRect(0, 0, px, px);
      }
      ctx.globalAlpha = op.alpha;
      ctx.drawImage(masks.scratch, 0, 0);
      continue;
    }
    const mask = tinted(masks, op.kind === "ring" ? "outline" : "glow", color);
    if (!mask) continue;
    ctx.globalAlpha = op.alpha;
    ctx.drawImage(mask, c - side / 2, c - side / 2, side, side);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

// ── the component ────────────────────────────────────────────────────────

/** How far beyond the avatar the aura reaches, as a multiple of its size. */
export const AURA_EXTENT = 2.3;

/** The canvas bitmap's side for a CSS extent, at a device pixel ratio capped at 2. */
function canvasPx(extent: number): number {
  return Math.round(extent * Math.min(2, window.devicePixelRatio || 1));
}

export function CallAura({
  phase,
  size,
  aura,
  variant = "full",
  strength = 1,
  signals,
}: {
  phase: AuraPhase;
  /** The avatar's rendered size, CSS px. */
  size: number;
  aura: AvatarAura;
  /** "soft": glow only, for a mascot or a quiet room member. */
  variant?: "full" | "soft";
  strength?: number;
  signals?: CallSignals;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const masksRef = useRef<{ key: string; masks: Masks } | null>(null);
  // the level and the live ripples outlive a phase change, so speaking into
  // listening eases rather than pops
  const smootherRef = useRef(new LevelSmoother(40, 260));
  const ripplesRef = useRef<number[]>([]);
  // one clock across phase changes: ripple births are on this timebase, so a
  // restart at 0 would revive them as ghost rings seconds later
  const startedRef = useRef<number | null>(null);
  const [extent, setExtent] = useState(() => Math.round(size * AURA_EXTENT));
  const [reduced, setReduced] = useState(false);
  const look: AuraLook = useMemo(() => (variant === "soft" ? softLook(AURA_LOOK[phase]) : AURA_LOOK[phase]), [phase, variant]);
  const fullStrength = (variant === "soft" ? 0.45 : 1) * strength;
  const color: Rgb = look.amber ? AMBER : look.dim ? desaturate(aura.color, 0.7) : aura.color;
  // the loop's mode: the ticker itself stops while the document is hidden
  const animated = auraMode({ phase, reducedMotion: reduced, hidden: false }) === "animated";

  // the viewport bounds the canvas on a phone, so the page never scrolls sideways
  useLayoutEffect(() => {
    const fit = () => setExtent(Math.round(Math.min(size * AURA_EXTENT, (window.innerWidth || Infinity) - 16)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [size]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  // size the canvas in its own effect, keyed on its extent alone: assigning
  // width clears and reallocates the bitmap, which a phase change must not do
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const px = canvasPx(extent);
    canvas.width = px;
    canvas.height = px;
  }, [extent]);

  const colorKey = color.join(",");
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const px = canvasPx(extent);
    const key = [px, size, aura.shape, aura.image?.src ?? "", aura.pixelArt].join("|");
    if (masksRef.current?.key !== key) {
      const built = buildMasks(px, (size / extent) * px, aura.shape, aura.image, aura.pixelArt);
      masksRef.current = built ? { key, masks: built } : null;
    }
    const masks = masksRef.current?.masks;
    if (!masks) return;
    const rgb = colorKey.split(",").map(Number) as Rgb;
    const bot = signals?.bot;
    const owner = signals?.owner;
    const smoother = smootherRef.current;
    const ripples = ripplesRef.current;
    let lastOnset = -Infinity;
    let wasLoud = false;
    const started = clockStart(startedRef, performance.now());

    const frame = (now: number, dt: number) => {
      const t = now - started;
      const level = smoother.push(
        frameLevel({ phase, t, bot: bot?.level() ?? 0, hearing: bot?.hearing() ?? false, owner: owner?.level() ?? 0 }),
        dt || 16,
      );
      if (look.reactive) {
        if (phase === "listening" && owner) {
          for (const at of owner.recentPulses(300)) {
            const born = t - (performance.now() - at);
            if (!ripples.some((r) => Math.abs(r - born) < 150)) ripples.push(born);
          }
        }
        // a rising edge in the bot's voice: a syllable sends a ring
        const loud = level > 0.45;
        if (phase === "speaking" && loud && !wasLoud && t - lastOnset > 260) {
          ripples.push(t);
          lastOnset = t;
        }
        wasLoud = loud;
      }
      const alive = liveRipples(ripples, t);
      ripples.length = 0;
      ripples.push(...alive);
      paint(ctx, masks, rgb, auraScene({ look, t, level, ripples, strength: fullStrength }));
    };

    if (!animated) {
      // one still frame: a resting glow, plus the held ring when there is one
      paint(ctx, masks, rgb, auraScene({ look, t: 0, level: reduced && phase === "speaking" ? 0.4 : 0, ripples: [], strength: fullStrength }));
      return;
    }
    return auraTicker().subscribe(frame);
  }, [extent, size, aura.shape, aura.image, aura.pixelArt, colorKey, phase, look, fullStrength, animated, reduced, signals]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-call-aura={phase}
      data-aura-shape={aura.shape}
      data-aura-mode={animated ? "animated" : "static"}
      data-aura-variant={variant}
      className="pointer-events-none absolute left-1/2 top-1/2 -z-10 -translate-x-1/2 -translate-y-1/2"
      style={{
        width: extent,
        height: extent,
        opacity: reduced ? staticOpacity(phase) : 1,
        transition: "opacity 600ms ease-out",
      }}
    />
  );
}
