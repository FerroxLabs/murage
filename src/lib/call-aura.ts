// The call aura's model: what each call phase looks like, which of those
// looks move, and the colour the avatar lends it. Pure functions and plain
// data, so CallAura.tsx (the canvas) stays a thin painter and the mapping
// is unit-tested without a DOM. See call-aura-design.md.

/** The call's phases as the aura reads them. CallView's own four phases
 *  plus the states its status line layers over them. */
export type AuraPhase = "connecting" | "listening" | "thinking" | "working" | "speaking" | "muted" | "held" | "reconnecting";

export type CallPhase = "listening" | "sending" | "working" | "speaking";

/** One phase's look. Alphas are 0..1 at full strength; the painter scales
 *  them by the aura's strength. */
export interface AuraLook {
  /** Glow alpha at rest and how far the level can push it. */
  glow: number;
  glowLevel: number;
  /** Breath: how much the glow radius swells (0 for none) and its period. */
  breath: number;
  breathMs: number;
  /** Rings born on a timer: how many are live at once, their period and
   *  stroke alpha. 0 rings means none. */
  rings: number;
  ringMs: number;
  ringAlpha: number;
  /** Orbiting arcs. */
  arcs: number;
  /** Rings also spawn on owner activity (listening) or voice onsets (speaking). */
  reactive: boolean;
  /** Painted once; nothing moves. */
  still: boolean;
  /** Amber instead of the avatar's colour. */
  amber: boolean;
  /** Pulled toward grey. */
  dim: boolean;
}

export const AURA_LOOK: Record<AuraPhase, AuraLook> = {
  connecting: { glow: 0.22, glowLevel: 0, breath: 0.03, breathMs: 2400, rings: 1, ringMs: 2400, ringAlpha: 0.45, arcs: 0, reactive: false, still: false, amber: false, dim: false },
  listening: { glow: 0.34, glowLevel: 0.6, breath: 0.07, breathMs: 4000, rings: 0, ringMs: 1600, ringAlpha: 0.55, arcs: 0, reactive: true, still: false, amber: false, dim: false },
  thinking: { glow: 0.26, glowLevel: 0, breath: 0.02, breathMs: 5000, rings: 0, ringMs: 0, ringAlpha: 0, arcs: 1, reactive: false, still: false, amber: false, dim: false },
  working: { glow: 0.28, glowLevel: 0, breath: 0.02, breathMs: 5000, rings: 0, ringMs: 0, ringAlpha: 0, arcs: 2, reactive: false, still: false, amber: false, dim: false },
  speaking: { glow: 0.34, glowLevel: 0.55, breath: 0, breathMs: 0, rings: 3, ringMs: 1500, ringAlpha: 0.7, arcs: 0, reactive: true, still: false, amber: false, dim: false },
  muted: { glow: 0.14, glowLevel: 0, breath: 0, breathMs: 0, rings: 0, ringMs: 0, ringAlpha: 0, arcs: 0, reactive: false, still: true, amber: false, dim: true },
  held: { glow: 0.22, glowLevel: 0, breath: 0, breathMs: 0, rings: 1, ringMs: 0, ringAlpha: 0.5, arcs: 0, reactive: false, still: true, amber: true, dim: false },
  reconnecting: { glow: 0.22, glowLevel: 0, breath: 0.04, breathMs: 1600, rings: 1, ringMs: 1600, ringAlpha: 0.5, arcs: 0, reactive: false, still: false, amber: true, dim: false },
};

/** The aura's phase from the call's state, in the order the status line
 *  resolves it: lost wins (the engine is coming back), then held ("Call
 *  paused"), then connecting, then muted, then the turn's own phase. */
export function auraPhaseFor(call: { phase: CallPhase; connecting?: boolean; muted?: boolean; held?: boolean; lost?: boolean }): AuraPhase {
  if (call.lost) return "reconnecting";
  if (call.held) return "held";
  if (call.connecting) return "connecting";
  if (call.muted) return "muted";
  if (call.phase === "sending") return "thinking";
  return call.phase;
}

export type AuraMode = "animated" | "static" | "paused";

/** Whether the aura runs its frame loop, paints once, or paints nothing
 *  new: reduced motion is always a single static paint; a hidden document
 *  stops the loop; a still look paints once. */
export function auraMode(input: { phase: AuraPhase; reducedMotion: boolean; hidden: boolean }): AuraMode {
  if (input.hidden) return "paused";
  if (input.reducedMotion) return "static";
  return AURA_LOOK[input.phase].still ? "static" : "animated";
}

/** Canvas opacity per phase under reduced motion, where opacity is the only
 *  thing allowed to change between phases. */
export function staticOpacity(phase: AuraPhase): number {
  switch (phase) {
    case "speaking":
      return 1;
    case "muted":
      return 0.45;
    case "connecting":
    case "reconnecting":
      return 0.7;
    default:
      return 0.85;
  }
}

export type Rgb = [number, number, number];

/** Parses #rgb or #rrggbb; null for anything else. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const n = Number.parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(channel(h + 1 / 3) * 255), Math.round(channel(h) * 255), Math.round(channel(h - 1 / 3) * 255)];
}

const HUE_BINS = 24;

/** A hue histogram of an image's RGBA pixels: 24 bins weighted by
 *  saturation and brightness, with the weighted colour sum per bin. Dull
 *  and near-black/white pixels carry no hue worth borrowing and are left
 *  out; `total` is the number of pixels looked at, see-through ones too. */
function hueHistogram(pixels: ArrayLike<number>): { weight: Float64Array; sum: Float64Array; total: number } {
  const weight = new Float64Array(HUE_BINS);
  const sum = new Float64Array(HUE_BINS * 3);
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const rgb: Rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
    const [h, s, l] = rgbToHsl(rgb);
    if (s < 0.2 || l < 0.12 || l > 0.92) continue;
    const w = s * (1 - Math.abs(l - 0.5) * 1.2);
    if (w <= 0) continue;
    const bin = Math.min(HUE_BINS - 1, Math.floor(h * HUE_BINS));
    weight[bin] += w;
    sum[bin * 3] += rgb[0] * w;
    sum[bin * 3 + 1] += rgb[1] * w;
    sum[bin * 3 + 2] += rgb[2] * w;
  }
  return { weight, sum, total: pixels.length / 4 };
}

/** The mean colour of the heaviest bin among `bins`, or null when none of
 *  them has at least a few per cent of the pixels behind it. */
function binColor({ weight, sum, total }: ReturnType<typeof hueHistogram>, bins: readonly number[]): Rgb | null {
  let best = -1;
  for (const b of bins) if (weight[b] > 0 && (best < 0 || weight[b] > weight[best])) best = b;
  if (best < 0 || weight[best] < total * 0.01) return null;
  return [sum[best * 3] / weight[best], sum[best * 3 + 1] / weight[best], sum[best * 3 + 2] / weight[best]].map(Math.round) as Rgb;
}

const ALL_BINS = Array.from({ length: HUE_BINS }, (_, b) => b);
/** Reds through yellows: 330° to 360° and 0° to 75° (bins of 15°). */
const WARM_BINS = ALL_BINS.filter((b) => b >= 22 || b < 5);

/**
 * The dominant hue of an image, from its RGBA pixels: a 24-bin hue
 * histogram weighted by saturation and brightness (a face against a dark
 * wall still answers the wall's hue only if it is more colourful), then the
 * mean colour of the winning bin. Null when nothing in the image is
 * colourful enough to lend a hue (a greyscale portrait).
 */
export function dominantColor(pixels: ArrayLike<number>): Rgb | null {
  return binColor(hueHistogram(pixels), ALL_BINS);
}

/** The strongest warm hue in the image, by the same histogram, or null when
 *  no warm bin holds a few per cent of the pixels. */
export function warmAccent(pixels: ArrayLike<number>): Rgb | null {
  return binColor(hueHistogram(pixels), WARM_BINS);
}

/** The same hue, lifted into a range that reads on a dark ground: clearly
 *  saturated, neither muddy nor washed out. */
export function vivid(rgb: Rgb): Rgb {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([h, Math.min(0.9, Math.max(0.6, s)), Math.min(0.66, Math.max(0.52, l))]);
}

/** Toward grey, for the muted look. */
export function desaturate(rgb: Rgb, amount: number): Rgb {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([h, s * (1 - amount), l]);
}

export const AMBER: Rgb = [251, 191, 36];

export function rgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

// ── shape ────────────────────────────────────────────────────────────────

/** The path the glow and the rings follow. */
export type AuraShape = "circle" | "rounded" | "square" | "silhouette";

/** What a sampled avatar image tells the aura. */
export interface ImageTraits {
  /** The dominant hue, or null for a greyscale image. */
  color: Rgb | null;
  /** The strongest warm hue in the image (a skin tone, a flame, a scarf),
   *  or null: the mood falls back on it when the dominant hue is cool. */
  warm: Rgb | null;
  /** A sprite: a meaningful share of its pixels are see-through. */
  transparent: boolean;
  /** width / height. */
  aspect: number;
  /** Small enough that its pixels are the drawing: keep them crisp. */
  pixelArt: boolean;
}

export const PIXEL_ART_MAX = 128;
export const TRANSPARENT_SHARE = 0.02;

/** Reads the traits off a sampled image's RGBA pixels. */
export function imageTraits(pixels: ArrayLike<number>, naturalWidth: number, naturalHeight: number): ImageTraits {
  let clear = 0;
  const total = Math.floor(pixels.length / 4);
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 128) clear += 1;
  return {
    color: dominantColor(pixels),
    warm: warmAccent(pixels),
    transparent: total > 0 && clear / total >= TRANSPARENT_SHARE,
    aspect: naturalHeight > 0 ? naturalWidth / naturalHeight : 1,
    pixelArt: naturalWidth > 0 && naturalWidth <= PIXEL_ART_MAX && naturalHeight > 0 && naturalHeight <= PIXEL_ART_MAX,
  };
}

/** A sprite follows its own silhouette whatever the crop says; the mascot
 *  and a circle crop are circles; the square crops are rounded squares. */
export function auraShapeFor(crop: "mascot" | "circle" | "rounded" | "square", traits: Pick<ImageTraits, "transparent"> | null): AuraShape {
  if (traits?.transparent && crop !== "mascot") return "silhouette";
  if (crop === "rounded") return "rounded";
  if (crop === "square") return "square";
  return "circle";
}

/** Corner radius as a share of the side, per shape. */
export const SHAPE_RADIUS: Record<Exclude<AuraShape, "silhouette">, number> = { circle: 0.5, rounded: 0.22, square: 0.12 };

// ── the scene ────────────────────────────────────────────────────────────

/** One thing to paint this frame, all relative to the avatar's own size. */
export type AuraOp =
  | { kind: "glow"; scale: number; alpha: number }
  | { kind: "ring"; scale: number; alpha: number }
  | { kind: "arc"; scale: number; alpha: number; angle: number; sweep: number };

export interface AuraSceneInput {
  look: AuraLook;
  /** Milliseconds since the aura mounted. */
  t: number;
  /** Smoothed level for this phase: the bot's voice while speaking, the
   *  owner's while listening. */
  level: number;
  /** When each reactive ripple was born (ms on the same clock). */
  ripples: readonly number[];
  /** 0..1: the soft variant scales everything down. */
  strength: number;
}

/** How far a ring travels before it is gone, as a multiple of the shape:
 *  short of the name and status under the avatar. */
export const RING_REACH = 0.7;
export const RIPPLE_MS = 1300;
/** A reactive ripple's alpha at birth. */
export const RIPPLE_ALPHA = 0.75;

/**
 * The frame's draw list for a look at time t. Pure: the painter only
 * executes it, and the tests only read it.
 */
export function auraScene({ look, t, level, ripples, strength }: AuraSceneInput): AuraOp[] {
  const ops: AuraOp[] = [];
  const breath = look.breath && look.breathMs ? (1 + Math.sin((t / look.breathMs) * Math.PI * 2)) / 2 : 0;
  const energy = look.glowLevel * level;
  ops.push({
    kind: "glow",
    scale: 1 + look.breath * breath + 0.22 * energy,
    alpha: (look.glow + energy + 0.12 * look.breath * breath * 4) * strength,
  });
  if (look.rings > 0) {
    if (look.still || !look.ringMs) {
      ops.push({ kind: "ring", scale: 1.12, alpha: look.ringAlpha * strength });
    } else {
      // a louder voice sends rings sooner
      const period = look.ringMs / (1 + 0.8 * level);
      for (let i = 0; i < look.rings; i += 1) {
        const phase = ((t + (i * period) / look.rings) % period) / period;
        ops.push({ kind: "ring", scale: 1 + RING_REACH * phase, alpha: look.ringAlpha * (1 - phase) * (0.55 + 0.45 * level) * strength });
      }
    }
  }
  if (look.reactive) {
    for (const born of ripples) {
      const age = (t - born) / RIPPLE_MS;
      if (age < 0 || age >= 1) continue;
      ops.push({ kind: "ring", scale: 1 + RING_REACH * age, alpha: RIPPLE_ALPHA * (1 - age) * strength });
    }
  }
  for (let i = 0; i < look.arcs; i += 1) {
    const period = i === 0 ? 6000 : 9000;
    const direction = i === 0 ? 1 : -1;
    ops.push({ kind: "arc", scale: 1.1 + i * 0.16, alpha: (0.7 - i * 0.2) * strength, angle: direction * ((t % period) / period) * Math.PI * 2, sweep: Math.PI * 0.6 });
  }
  return ops;
}

/** Ripples still worth painting. */
/** The aura's clock origin: set once, then the same on every later call, so
 *  ripple births survive a phase change on one timebase. */
export function clockStart(ref: { current: number | null }, now: number): number {
  if (ref.current === null) ref.current = now;
  return ref.current;
}

export function liveRipples(ripples: readonly number[], t: number): number[] {
  return ripples.filter((born) => t - born < RIPPLE_MS);
}

/**
 * A speech-like modulation for the paths with no loudness to read (the
 * iPhone's native player, WebKit): three slow sines, never silent, never loud.
 */
export function syntheticSpeech(t: number): number {
  const s = Math.sin(t / 190) * 0.5 + Math.sin(t / 73 + 1.3) * 0.3 + Math.sin(t / 410 + 0.4) * 0.2;
  return 0.3 + 0.25 * (s + 1) * 0.5;
}

/**
 * The level that drives a frame, the painter's one decision: the bot's real
 * loudness while a clip is tapped (its pauses included, so a silence is a
 * silence), the synthetic cadence only when nothing can be heard at all;
 * the owner's level while listening; nothing in the other phases.
 */
export function frameLevel(input: { phase: AuraPhase; t: number; bot: number; hearing: boolean; owner: number }): number {
  if (input.phase === "speaking") return input.hearing ? input.bot : syntheticSpeech(input.t);
  if (input.phase === "listening") return input.owner;
  return 0;
}

/** Peak wash opacity per skin: the whole ground shifts on dark; light
 *  keeps the text's contrast with a lighter touch. */
export const MOOD_PEAK = { dark: 0.9, light: 0.7 } as const;

// ── read-along ───────────────────────────────────────────────────────────

/** Characters a second a voice gets through, for clips of unknown length. */
export const SPEECH_CPS = 15;

/** A sentence as words with the share of its characters each word ends at. */
export function readAlongWords(text: string): { word: string; end: number }[] {
  const words = text.split(/\s+/).filter(Boolean);
  const total = words.reduce((n, w) => n + w.length, 0) || 1;
  let seen = 0;
  return words.map((word) => {
    seen += word.length;
    return { word, end: seen / total };
  });
}

/**
 * How far through a clip its sound has got, 0..1: by its real duration
 * when known; by what has buffered for a clip still downloading; else by
 * the sentence's length at SPEECH_CPS.
 */
export function clipProgress(clip: { currentTime: number; duration: number; bufferedEnd: number | null }, chars: number): number {
  const byRate = chars / SPEECH_CPS;
  const length = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : Math.max(clip.bufferedEnd ?? 0, byRate);
  if (length <= 0) return 0;
  return Math.max(0, Math.min(1, clip.currentTime / length));
}

/**
 * The index of the last lit word for a sentence whose words end at `ends`
 * (shares of its characters) when the sound has reached `progress`: the
 * word the sound is in, and every word before it. Never below `previous`:
 * a streamed clip's length jumps from what had buffered to its real
 * duration when that resolves, and the ratio can step back; a word once
 * lit stays lit.
 */
export function litWordIndex(ends: readonly number[], progress: number, previous: number): number {
  if (ends.length === 0) return -1;
  let upto = -1;
  for (let i = 0; i < ends.length; i += 1) if (ends[i] <= progress + 0.02) upto = i;
  return Math.max(previous, Math.min(ends.length - 1, upto + 1));
}

/** Progress from time alone, for a clip the page never hears. */
export function timedProgress(elapsedMs: number, chars: number): number {
  const length = (chars / SPEECH_CPS) * 1000;
  return length <= 0 ? 1 : Math.max(0, Math.min(1, elapsedMs / length));
}

/** The soft variant: glow only, for a mascot with its own animation or a
 *  room member who is not the one talking. */
export function softLook(look: AuraLook): AuraLook {
  return { ...look, rings: 0, arcs: 0, reactive: false };
}

/** The cool wash for the owner's voice. */
export const OWNER_BLUE: Rgb = [96, 150, 255];

/** The bot's mood must never be mistaken for the owner's: its hue stays at
 *  least this far (degrees) from OWNER_BLUE's. */
export const MOOD_HUE_GAP = 90;
/** Too grey to carry a hue of its own. */
const MOOD_MIN_SATURATION = 0.25;
/** The warm fallbacks: an orange for a cool avatar on the green side of
 *  blue (teal, cyan, a grey one too), a coral for one on the violet side. */
export const MOOD_WARM: { readonly orange: Rgb; readonly coral: Rgb } = { orange: [255, 128, 72], coral: [255, 104, 112] };

/** Hue in degrees, 0 to 360. */
export function hueOf(rgb: Rgb): number {
  return rgbToHsl(rgb)[0] * 360;
}

/** The shorter way round the wheel between two hues, in degrees (0 to 180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * The colour the bot's mood floods the screen with while it talks. The
 * owner's turn is always cool blue; the bot's turn must read warm and
 * unmistakably different, the way a voice assistant tells the two sides
 * apart. So the avatar's own hue is used only when it is far enough from
 * OWNER_BLUE (MOOD_HUE_GAP) and saturated enough to be a hue at all. A
 * cool or grey avatar borrows its sampled warm accent (a skin tone, a
 * flame) when one is far enough from blue, and otherwise a fixed warm:
 * orange on the green side of blue, coral on the violet side. Pure: no DOM.
 */
export function moodColor(avatar: Rgb | null, warm: Rgb | null = null): Rgb {
  const ownerHue = hueOf(OWNER_BLUE);
  const ownHue = avatar ? hueOf(avatar) : null;
  const usable = (rgb: Rgb | null): rgb is Rgb => rgb !== null && rgbToHsl(rgb)[1] >= MOOD_MIN_SATURATION && hueDistance(hueOf(rgb), ownerHue) >= MOOD_HUE_GAP;
  if (usable(avatar)) return vivid(avatar);
  if (usable(warm)) return vivid(warm);
  // which side of blue: hues from blue round through violet to red take the coral
  const violetSide = ownHue !== null && avatar !== null && rgbToHsl(avatar)[1] >= MOOD_MIN_SATURATION && ((ownHue - ownerHue + 360) % 360) < 180;
  return violetSide ? MOOD_WARM.coral : MOOD_WARM.orange;
}
