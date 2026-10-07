import { describe, expect, it } from "vitest";

import {
  AURA_LOOK,
  auraMode,
  frameLevel,
  litWordIndex,
  MOOD_PEAK,
  RING_REACH,
  auraPhaseFor,
  auraScene,
  auraShapeFor,
  clipProgress,
  dominantColor,
  hueDistance,
  hueOf,
  MOOD_HUE_GAP,
  moodColor,
  OWNER_BLUE,
  warmAccent,
  imageTraits,
  liveRipples,
  clockStart,
  parseHex,
  readAlongWords,
  RIPPLE_MS,
  rgbToHsl,
  softLook,
  staticOpacity,
  syntheticSpeech,
  timedProgress,
  vivid,
  type AuraPhase,
} from "./call-aura";

describe("phase to visual mapping", () => {
  it("resolves the call's state in the status line's order: lost, held, connecting, muted, then the turn", () => {
    expect(auraPhaseFor({ phase: "speaking", lost: true, held: true, connecting: true, muted: true })).toBe("reconnecting");
    expect(auraPhaseFor({ phase: "speaking", held: true, connecting: true, muted: true })).toBe("held");
    expect(auraPhaseFor({ phase: "speaking", connecting: true, muted: true })).toBe("connecting");
    expect(auraPhaseFor({ phase: "speaking", muted: true })).toBe("muted");
    expect(auraPhaseFor({ phase: "listening" })).toBe("listening");
    expect(auraPhaseFor({ phase: "sending" })).toBe("thinking");
    expect(auraPhaseFor({ phase: "working" })).toBe("working");
    expect(auraPhaseFor({ phase: "speaking" })).toBe("speaking");
  });

  it("gives every phase a distinct signature", () => {
    const signature = (phase: AuraPhase) => {
      const l = AURA_LOOK[phase];
      return [l.rings, l.arcs, l.reactive, l.still, l.amber, l.dim, l.breathMs, l.glowLevel > 0].join("|");
    };
    const phases = Object.keys(AURA_LOOK) as AuraPhase[];
    expect(new Set(phases.map(signature)).size).toBe(phases.length);
    expect(AURA_LOOK.connecting).toMatchObject({ rings: 1, ringMs: 2400, arcs: 0 });
    expect(AURA_LOOK.listening).toMatchObject({ reactive: true, breathMs: 4000, rings: 0 });
    expect(AURA_LOOK.thinking).toMatchObject({ arcs: 1, rings: 0 });
    expect(AURA_LOOK.working).toMatchObject({ arcs: 2, rings: 0 });
    expect(AURA_LOOK.speaking).toMatchObject({ rings: 3, reactive: true });
    expect(AURA_LOOK.muted).toMatchObject({ still: true, dim: true, rings: 0, arcs: 0 });
    expect(AURA_LOOK.held).toMatchObject({ still: true, amber: true });
    expect(AURA_LOOK.reconnecting).toMatchObject({ amber: true, still: false, rings: 1 });
  });

  it("paints the scene each phase describes", () => {
    const scene = (phase: AuraPhase, t: number, level = 0) => auraScene({ look: AURA_LOOK[phase], t, level, ripples: [], strength: 1 });
    const kinds = (ops: ReturnType<typeof auraScene>) => ops.map((op) => op.kind);
    expect(kinds(scene("muted", 500))).toEqual(["glow"]);
    expect(kinds(scene("held", 500))).toEqual(["glow", "ring"]);
    expect(kinds(scene("thinking", 500))).toEqual(["glow", "arc"]);
    expect(kinds(scene("working", 500))).toEqual(["glow", "arc", "arc"]);
    expect(kinds(scene("connecting", 500))).toEqual(["glow", "ring"]);
    expect(kinds(scene("speaking", 500))).toEqual(["glow", "ring", "ring", "ring"]);
    // the two working arcs orbit in opposite directions at different speeds
    const [, a, b] = scene("working", 1500) as Extract<ReturnType<typeof auraScene>[number], { kind: "arc" }>[];
    expect(Math.sign(a.angle)).toBe(1);
    expect(Math.sign(b.angle)).toBe(-1);
  });

  it("drives the speaking rings and glow with the voice level", () => {
    const quiet = auraScene({ look: AURA_LOOK.speaking, t: 400, level: 0, ripples: [], strength: 1 });
    const loud = auraScene({ look: AURA_LOOK.speaking, t: 400, level: 1, ripples: [], strength: 1 });
    expect(loud[0].alpha).toBeGreaterThan(quiet[0].alpha);
    expect(loud[0].scale).toBeGreaterThan(quiet[0].scale);
    const quietRing = quiet.find((op) => op.kind === "ring")!;
    const loudRing = loud.find((op) => op.kind === "ring")!;
    expect(loudRing.alpha).toBeGreaterThan(quietRing.alpha);
  });

  it("breathes while listening, brightening with the owner", () => {
    const rest = auraScene({ look: AURA_LOOK.listening, t: 0, level: 0, ripples: [], strength: 1 });
    const top = auraScene({ look: AURA_LOOK.listening, t: 1000, level: 0, ripples: [], strength: 1 });
    expect(top[0].scale).toBeGreaterThan(rest[0].scale);
    const owner = auraScene({ look: AURA_LOOK.listening, t: 0, level: 1, ripples: [], strength: 1 });
    expect(owner[0].alpha).toBeGreaterThan(rest[0].alpha);
  });

  it("spawns a ripple ring per owner partial while listening, and lets it fade", () => {
    const born = auraScene({ look: AURA_LOOK.listening, t: 1000, level: 0, ripples: [1000], strength: 1 });
    expect(born.filter((op) => op.kind === "ring")).toHaveLength(1);
    const half = auraScene({ look: AURA_LOOK.listening, t: 1000 + RIPPLE_MS / 2, level: 0, ripples: [1000], strength: 1 });
    const ring = half.find((op) => op.kind === "ring")!;
    // rings reach 0.7 of the shape and stop short of the name under it
    expect(ring.scale).toBeCloseTo(1 + 0.35, 2);
    expect(ring.alpha).toBeCloseTo(0.375, 2);
    expect(liveRipples([1000, 5000], 1000 + RIPPLE_MS + 1)).toEqual([5000]);
    // the clock origin is fixed across phase changes, so a ripple born at t=6000
    // is never in the future of a later effect (no ghost ring seconds on)
    const ref = { current: null as number | null };
    expect(clockStart(ref, 100)).toBe(100);
    expect(clockStart(ref, 9000)).toBe(100);
    expect(9000 - clockStart(ref, 9000)).toBeGreaterThan(6000);
    // a still look ignores ripples
    expect(auraScene({ look: AURA_LOOK.muted, t: 1000, level: 1, ripples: [1000], strength: 1 })).toHaveLength(1);
  });

  it("the soft variant keeps the glow and drops the rings and arcs", () => {
    expect(softLook(AURA_LOOK.speaking)).toMatchObject({ rings: 0, arcs: 0, reactive: false, glow: AURA_LOOK.speaking.glow });
    expect(auraScene({ look: softLook(AURA_LOOK.working), t: 500, level: 0, ripples: [], strength: 0.45 }).map((op) => op.kind)).toEqual(["glow"]);
  });

  it("the synthetic cadence is never silent and never loud", () => {
    for (let t = 0; t < 20_000; t += 37) {
      const v = syntheticSpeech(t);
      expect(v).toBeGreaterThan(0.25);
      expect(v).toBeLessThan(0.6);
    }
  });
});

describe("reduced motion and hidden", () => {
  it("reduced motion is a single static paint, a hidden document paints nothing new, still looks paint once", () => {
    expect(auraMode({ phase: "speaking", reducedMotion: true, hidden: false })).toBe("static");
    expect(auraMode({ phase: "speaking", reducedMotion: false, hidden: true })).toBe("paused");
    expect(auraMode({ phase: "speaking", reducedMotion: true, hidden: true })).toBe("paused");
    expect(auraMode({ phase: "muted", reducedMotion: false, hidden: false })).toBe("static");
    expect(auraMode({ phase: "held", reducedMotion: false, hidden: false })).toBe("static");
    expect(auraMode({ phase: "listening", reducedMotion: false, hidden: false })).toBe("animated");
  });

  it("under reduced motion only the opacity tells the phases apart", () => {
    expect(staticOpacity("speaking")).toBe(1);
    expect(staticOpacity("muted")).toBeLessThan(staticOpacity("listening"));
    expect(staticOpacity("connecting")).toBeLessThan(staticOpacity("speaking"));
  });
});

describe("shape", () => {
  it("a sprite with transparency follows its silhouette; crops follow their path; the mascot is a circle", () => {
    expect(auraShapeFor("circle", { transparent: true })).toBe("silhouette");
    expect(auraShapeFor("square", { transparent: true })).toBe("silhouette");
    expect(auraShapeFor("mascot", { transparent: true })).toBe("circle");
    expect(auraShapeFor("circle", { transparent: false })).toBe("circle");
    expect(auraShapeFor("rounded", null)).toBe("rounded");
    expect(auraShapeFor("square", null)).toBe("square");
  });

  it("reads transparency, aspect and pixel art off the sample", () => {
    const px = (n: number, fill: number[]) => {
      const out = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i += 1) out.set(fill, i * 4);
      return out;
    };
    const opaque = px(100, [200, 40, 40, 255]);
    expect(imageTraits(opaque, 640, 480)).toMatchObject({ transparent: false, aspect: 640 / 480, pixelArt: false });
    const sprite = px(100, [200, 40, 40, 255]);
    for (let i = 0; i < 5; i += 1) sprite[i * 4 + 3] = 0;
    expect(imageTraits(sprite, 64, 64)).toMatchObject({ transparent: true, pixelArt: true });
    // a single see-through pixel in a hundred is an edge, not a sprite
    const edge = px(100, [200, 40, 40, 255]);
    edge[3] = 0;
    expect(imageTraits(edge, 256, 256).transparent).toBe(false);
  });
});

describe("colour", () => {
  it("parses hex and lifts a hue into the on-dark range", () => {
    expect(parseHex("#ff6b35")).toEqual([255, 107, 53]);
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("orange")).toBeNull();
    const [, s, l] = rgbToHsl(vivid([40, 30, 90]));
    expect(s).toBeGreaterThanOrEqual(0.59);
    expect(l).toBeGreaterThanOrEqual(0.51);
    expect(l).toBeLessThanOrEqual(0.67);
  });

  it("finds the colourful hue in a mostly grey portrait and gives up on greyscale", () => {
    const pixels = new Uint8ClampedArray(400 * 4);
    for (let i = 0; i < 400; i += 1) pixels.set(i < 360 ? [80, 80, 80, 255] : [30, 120, 220, 255], i * 4);
    const found = dominantColor(pixels)!;
    expect(found).not.toBeNull();
    const [h] = rgbToHsl(found);
    expect(h).toBeGreaterThan(0.55);
    expect(h).toBeLessThan(0.65);
    const grey = new Uint8ClampedArray(100 * 4);
    for (let i = 0; i < 100; i += 1) grey.set([90, 90, 90, 255], i * 4);
    expect(dominantColor(grey)).toBeNull();
  });

  it("finds the warm accent in a cool image, and none when nothing warm is there", () => {
    // a teal wall with a skin-toned face over a fifth of it
    const pixels = new Uint8ClampedArray(500 * 4);
    for (let i = 0; i < 500; i += 1) pixels.set(i < 400 ? [22, 56, 74, 255] : [233, 183, 142, 255], i * 4);
    const warm = warmAccent(pixels)!;
    expect(warm).not.toBeNull();
    expect(hueOf(warm)).toBeGreaterThan(15);
    expect(hueOf(warm)).toBeLessThan(45);
    // the dominant hue is still the wall's
    expect(hueDistance(hueOf(dominantColor(pixels)!), hueOf(OWNER_BLUE))).toBeLessThan(MOOD_HUE_GAP);
    const cool = new Uint8ClampedArray(100 * 4);
    for (let i = 0; i < 100; i += 1) cool.set([30, 120, 220, 255], i * 4);
    expect(warmAccent(cool)).toBeNull();
    // a warm fleck in one pixel of a hundred is not an accent
    const fleck = new Uint8ClampedArray(200 * 4);
    for (let i = 0; i < 200; i += 1) fleck.set(i === 0 ? [255, 140, 60, 255] : [30, 120, 220, 255], i * 4);
    expect(warmAccent(fleck)).toBeNull();
  });
});

describe("moodColor", () => {
  const ownerHue = hueOf(OWNER_BLUE);
  const gap = (rgb: [number, number, number]) => hueDistance(hueOf(rgb), ownerHue);
  const TEAL: [number, number, number] = [1, 164, 146];
  const BLUE: [number, number, number] = [55, 127, 230];
  const GREEN: [number, number, number] = [0, 153, 87];
  const RED: [number, number, number] = [217, 75, 82];
  const GREY: [number, number, number] = [120, 120, 120];
  const PURPLE: [number, number, number] = [128, 87, 200];

  it("always lands at least MOOD_HUE_GAP degrees from the owner's blue, for any avatar", () => {
    for (const avatar of [TEAL, BLUE, GREEN, RED, GREY, PURPLE, OWNER_BLUE, [14, 165, 198] as [number, number, number], [255, 255, 255] as [number, number, number]]) {
      expect(gap(moodColor(avatar)), `avatar ${avatar.join(",")}`).toBeGreaterThanOrEqual(MOOD_HUE_GAP);
    }
    expect(gap(moodColor(null))).toBeGreaterThanOrEqual(MOOD_HUE_GAP);
  });

  it("keeps a warm avatar's own hue and reads warm", () => {
    const mood = moodColor(RED);
    expect(hueDistance(hueOf(mood), hueOf(RED))).toBeLessThan(2);
    expect(hueDistance(hueOf(moodColor([255, 107, 53])), 20)).toBeLessThan(5);
  });

  it("shifts a cool avatar to a warm hue: orange on the green side of blue, coral on the violet side, orange for grey", () => {
    for (const avatar of [TEAL, BLUE, GREEN, GREY, [14, 165, 198] as [number, number, number]]) {
      const h = hueOf(moodColor(avatar));
      expect(h, `avatar ${avatar.join(",")}`).toBeGreaterThan(10);
      expect(h, `avatar ${avatar.join(",")}`).toBeLessThan(45);
    }
    const purple = hueOf(moodColor(PURPLE));
    expect(purple > 340 || purple < 10).toBe(true);
  });

  it("borrows the avatar's sampled warm accent when it has one, and ignores a cool or grey one", () => {
    const skin: [number, number, number] = [233, 183, 142];
    const mood = moodColor(TEAL, skin);
    expect(hueDistance(hueOf(mood), hueOf(skin))).toBeLessThan(2);
    expect(gap(mood)).toBeGreaterThanOrEqual(MOOD_HUE_GAP);
    // the accent is lifted into the on-dark range, not used raw
    const [, s, l] = rgbToHsl(mood);
    expect(s).toBeGreaterThanOrEqual(0.59);
    expect(l).toBeLessThanOrEqual(0.67);
    expect(moodColor(TEAL, [60, 90, 200])).toEqual(moodColor(TEAL));
    expect(moodColor(TEAL, GREY)).toEqual(moodColor(TEAL));
    // a warm avatar never defers to its accent
    expect(moodColor(RED, skin)).toEqual(moodColor(RED));
  });

  it("measures hue distance the short way round", () => {
    expect(hueDistance(10, 350)).toBe(20);
    expect(hueDistance(0, 180)).toBe(180);
    expect(hueDistance(220, 40)).toBe(180);
    expect(hueDistance(-30, 30)).toBe(60);
  });
});

describe("read-along", () => {
  it("splits a sentence into words that end at their share of the characters", () => {
    expect(readAlongWords("Here is the answer.")).toEqual([
      { word: "Here", end: 4 / 16 },
      { word: "is", end: 6 / 16 },
      { word: "the", end: 9 / 16 },
      { word: "answer.", end: 1 },
    ]);
    expect(readAlongWords("   ")).toEqual([]);
  });

  it("measures clip progress by duration, else by what has buffered, else by the sentence's length", () => {
    expect(clipProgress({ currentTime: 1, duration: 4, bufferedEnd: 2 }, 100)).toBe(0.25);
    expect(clipProgress({ currentTime: 1, duration: Number.NaN, bufferedEnd: 2 }, 15)).toBe(0.5);
    expect(clipProgress({ currentTime: 1, duration: Number.POSITIVE_INFINITY, bufferedEnd: null }, 30)).toBe(0.5);
    expect(clipProgress({ currentTime: 9, duration: 4, bufferedEnd: null }, 30)).toBe(1);
    expect(timedProgress(1000, 30)).toBe(0.5);
    expect(timedProgress(5000, 30)).toBe(1);
  });
});

describe("the frame's level (the painter's one decision)", () => {
  it("speaking: the bot's real level while a clip is tapped, the synthetic cadence only when nothing is heard", () => {
    expect(frameLevel({ phase: "speaking", t: 500, bot: 0.2, hearing: true, owner: 0.9 })).toBe(0.2);
    // a real pause in the bot's speech is silence, not invented speech
    expect(frameLevel({ phase: "speaking", t: 500, bot: 0, hearing: true, owner: 0.9 })).toBe(0);
    expect(frameLevel({ phase: "speaking", t: 500, bot: 0, hearing: false, owner: 0.9 })).toBe(syntheticSpeech(500));
  });

  it("listening: the owner's level; every other phase: nothing", () => {
    expect(frameLevel({ phase: "listening", t: 0, bot: 0.9, hearing: true, owner: 0.4 })).toBe(0.4);
    for (const phase of ["connecting", "thinking", "working", "muted", "held", "reconnecting"] as const) {
      expect(frameLevel({ phase, t: 0, bot: 0.9, hearing: true, owner: 0.9 })).toBe(0);
    }
  });
});

describe("the listening look answers the owner", () => {
  it("glows with the owner's level, breathes visibly, and the ripples read", () => {
    expect(AURA_LOOK.listening.glowLevel).toBeGreaterThanOrEqual(0.6);
    expect(AURA_LOOK.listening.breath).toBeGreaterThanOrEqual(0.07);
    const quiet = auraScene({ look: AURA_LOOK.listening, t: 0, level: 0, ripples: [], strength: 1 });
    const loud = auraScene({ look: AURA_LOOK.listening, t: 0, level: 1, ripples: [], strength: 1 });
    expect(loud[0].alpha - quiet[0].alpha).toBeGreaterThanOrEqual(0.6);
    const fresh = auraScene({ look: AURA_LOOK.listening, t: 1000, level: 0, ripples: [1000], strength: 1 }).find((op) => op.kind === "ring")!;
    expect(fresh.alpha).toBeCloseTo(0.75, 2);
    expect(RING_REACH).toBeLessThanOrEqual(0.7);
  });
});

describe("the mood's peak", () => {
  it("is unmistakable on dark and lighter on light", () => {
    expect(MOOD_PEAK.dark).toBeGreaterThanOrEqual(0.9);
    expect(MOOD_PEAK.light).toBeGreaterThanOrEqual(0.7);
    expect(MOOD_PEAK.light).toBeLessThan(MOOD_PEAK.dark);
  });
});

describe("read-along word lighting", () => {
  const ends = readAlongWords("Here is the answer.").map((w) => w.end);

  it("lights the word the sound is in, and the ones before it", () => {
    expect(litWordIndex(ends, 0, -1)).toBe(0);
    expect(litWordIndex(ends, 4 / 16, -1)).toBe(1);
    expect(litWordIndex(ends, 0.5, -1)).toBe(2);
    expect(litWordIndex(ends, 1, -1)).toBe(3);
    expect(litWordIndex([], 0.5, -1)).toBe(-1);
  });

  it("never un-lights a word: a clip whose duration resolves late may step its progress back, the words stay lit", () => {
    const lit = litWordIndex(ends, 0.7, -1);
    expect(lit).toBe(3);
    // the streamed clip's length jumps from what had buffered to the real
    // duration and the ratio drops
    expect(litWordIndex(ends, 0.2, lit)).toBe(3);
    expect(litWordIndex(ends, 0, lit)).toBe(3);
  });
});
