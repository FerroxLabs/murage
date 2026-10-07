// Rendered where it can be (this repo's vitest runs under node, no DOM:
// renderToStaticMarkup only). The per-frame decisions (which level drives a
// frame, which words are lit, the loop's mode) are pure functions in
// src/lib/call-aura.ts and tested by behaviour there; the wiring of the two
// call screens, which cannot render under node, is pinned to the source the
// same way CallView.test.ts explains in its header.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AURA_EXTENT, CallAura, type AvatarAura } from "./CallAura";
import { CallMood } from "./CallMood";
import { ReadAlong } from "./ReadAlong";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const aura: AvatarAura = { shape: "circle", color: [255, 107, 53], mood: [255, 107, 53], image: null, pixelArt: false, presentation: null, custom: true, crop: "circle" };

describe("CallAura", () => {
  it("is a decorative canvas behind the avatar, sized to reach past it", () => {
    const html = renderToStaticMarkup(createElement(CallAura, { phase: "speaking", size: 220, aura }));
    expect(html).toMatch(/^<canvas /);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-call-aura="speaking"');
    expect(html).toContain('data-aura-shape="circle"');
    expect(html).toContain("pointer-events-none");
    expect(html).toContain(`width:${Math.round(220 * AURA_EXTENT)}px`);
    expect(html).toContain("-z-10");
  });

  it("paints still phases once and animates the rest", () => {
    expect(renderToStaticMarkup(createElement(CallAura, { phase: "muted", size: 220, aura }))).toContain('data-aura-mode="static"');
    expect(renderToStaticMarkup(createElement(CallAura, { phase: "held", size: 220, aura }))).toContain('data-aura-mode="static"');
    expect(renderToStaticMarkup(createElement(CallAura, { phase: "listening", size: 220, aura }))).toContain('data-aura-mode="animated"');
  });

  it("follows the avatar's shape", () => {
    for (const shape of ["silhouette", "rounded", "square"] as const) {
      expect(renderToStaticMarkup(createElement(CallAura, { phase: "listening", size: 220, aura: { ...aura, shape } }))).toContain(`data-aura-shape="${shape}"`);
    }
  });

  it("a phase change neither clears the canvas nor restarts the level: the canvas is sized by its own effect and the smoother lives in a ref", () => {
    const source = read("./CallAura.tsx");
    const sizing = source.slice(source.indexOf("// size the canvas"), source.indexOf("}, [extent]);"));
    expect(sizing).toContain("canvas.width = px;");
    const painting = source.slice(source.indexOf("}, [extent]);"));
    expect(painting).not.toContain("canvas.width =");
    expect(painting).not.toContain("new LevelSmoother(");
    expect(source).toContain("const smootherRef = useRef(new LevelSmoother(40, 260));");
  });
});

describe("CallMood", () => {
  it("is two decorative washes: the owner's cool blue over the whole ground from the foot, the bot's own hue around the avatar", () => {
    const html = renderToStaticMarkup(createElement(CallMood, { phase: "speaking", color: [255, 107, 53] }));
    expect(html).toContain('data-call-mood="speaking"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-mood="bot"');
    expect(html).toContain('data-mood="owner"');
    // the bot's wash: centred on the avatar, strong at the centre
    expect(html).toContain("ellipse 130% 105% at 50% 36%");
    // and a base over the whole ground, so the foot of the screen flips warm too
    expect(html).toContain("rgba(255, 107, 53, 0.100)");
    expect(html).toContain("rgba(255, 107, 53, 0.620)");
    // the owner's wash: the whole ground reads cool (a base layer), rising from the foot
    expect(html).toContain("rgba(96, 150, 255, 0.100)");
    expect(html).toContain("ellipse 140% 95% at 50% 90%");
    expect(html).toContain("rgba(96, 150, 255, 0.620)");
    // no CSS transition on top of the smoother: the smoother already eases
    expect(html).not.toContain("transition:opacity");
    // beneath every in-flow sibling: the controls keep their true colours
    expect(html).toMatch(/data-call-mood="speaking" class="[^"]* -z-10 /);
    // held and reconnecting: amber, not the bot's hue
    expect(renderToStaticMarkup(createElement(CallMood, { phase: "held", color: [255, 107, 53] }))).toContain("rgba(251, 191, 36, 0.620)");
  });
});

describe("ReadAlong", () => {
  it("shows what was heard bright, the sentence audible word by word, and what is to come dim, with only the current sentence for assistive tech", () => {
    const html = renderToStaticMarkup(
      createElement(ReadAlong, { spoken: ["First one.", "Second one.", "Third one."], current: "Here is the answer.", queued: ["Then this.", "And this.", "Never shown."] }),
    );
    // the last two heard, never more, and not announced again
    expect(html).not.toContain("First one.");
    expect(html).toMatch(/<p[^>]*data-read-along="spoken"[^>]*aria-hidden="true"[^>]*>Second one\.<\/p>/);
    expect(html).toContain("Third one.");
    // the current sentence as spans, dim until lit
    const current = html.slice(html.indexOf('data-read-along="current"'));
    expect(current.match(/<span /g)).toHaveLength(4);
    expect(current).toContain("opacity:0.32");
    expect(current.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).toContain("Here is the answer.");
    // the next two to come: plain dim text, hidden from assistive tech
    expect(html).toMatch(/<p[^>]*data-read-along="queued"[^>]*aria-hidden="true"[^>]*>Then this\.<\/p>/);
    expect(html).toContain(">And this.</p>");
    expect(html).not.toContain("Never shown.");
    expect(html).not.toContain("data-text=");
  });

  it("fits a fixed slot so the avatar never moves between the owner's turn and the bot's", () => {
    const html = renderToStaticMarkup(createElement(ReadAlong, { current: "Here is the answer." }));
    expect(html).toContain("max-h-[9.5rem]");
  });
});

describe("the call screens wear it", () => {
  const callView = read("./CallView.tsx");
  const groupView = read("./GroupCallView.tsx");

  it("CallView: mood first, the avatar with every state the aura reads, the bot's clips tapped on the web path only", () => {
    expect(callView).toContain("<CallMood phase={auraPhase} color={avatarAura.mood} signals={signals} />");
    // the screen is a stacking context, so the mood's -z-10 sits above its ground and beneath its content
    expect(callView).toContain('className="pointer-events-auto absolute inset-0 isolate z-30 flex');
    // keyboard hints only where there is a keyboard
    expect(callView).toMatch(/\{keyboardHints && \(\n\s+<div className="text-\[11\.5px\] text-ink-secondary\/70" data-call-keyboard-hints>/);
    expect(callView).toContain("const keyboardHints = useKeyboardHints();");
    expect(callView).toContain("<CallAvatar bot={bot} phase={phase} held={held} inhale={inhale} connecting={connecting} muted={muted} lost={lost} signals={signals} />");
    expect(callView).toContain("const auraPhase = auraPhaseFor({ phase, connecting, muted, held, lost });");
    expect(callView).toContain('if (audioPath !== "web") return;\n    return botVoice.attach();');
    expect(callView).toContain("offLevel = mic.onLevel?.((rms) => signals.owner.push(rms)) ?? (() => {});");
    expect(callView).toContain("if (line.partial !== false) signals.owner.pulse();");
    // the mic's own cleanup drops the level listener with the rest
    expect(callView).toMatch(/offVoice\(\);\n\s+offLevel\(\);\n\s+offAudio\(\);/);
  });

  it("GroupCallView: the member talking carries the full aura, the others a soft one; the mood takes the talker's colour", () => {
    expect(groupView).toContain("<MemberCallAvatar");
    expect(groupView).toContain("focused={focused}");
    expect(groupView).toContain("<CallMood phase={auraPhase} color={moodAura.mood} signals={signals} />");
    expect(groupView).toContain('className="pointer-events-auto absolute inset-0 isolate z-30 flex');
    expect(groupView).toMatch(/\{keyboardHints && \(\n\s+<div className="text-\[11\.5px\] text-ink-secondary\/70" data-call-keyboard-hints>/);
    expect(groupView).toContain("const keyboardHints = useKeyboardHints();");
    expect(groupView).toContain("useAvatarAura(speakingMember ?? workingMember ?? members[0] ?? { color: \"orange\" })");
    expect(groupView).toContain("useEffect(() => botVoice.attach(), []);");
    expect(groupView).toContain("<ReadAlong spoken={speech.spoken} current={speech.caption} queued={speech.queued} progress={readAlongProgress} />");
    // the room's caption slot is fixed too, so the row of members never jumps
    expect(groupView).toContain("h-[9.5rem]");
    const avatar = read("./CallAvatar.tsx");
    expect(avatar).toContain('variant={focused && aura.custom ? "full" : "soft"}');
    expect(avatar).toContain("strength={focused ? 1 : 0.55}");
  });

  it("the audio path is never touched: the player only announces its element, the mic only hands out the RMS it already had", () => {
    const player = read("../lib/tts/index.ts");
    expect(player).toContain("export function onClipElement(fn: (audio: HTMLAudioElement) => void): () => void {");
    expect(player).toMatch(/this\.objectUrl = url;\n\s+for \(const watch of \[\.\.\.clipWatchers\]\)/);
    const mic = read("../lib/call-mic.ts");
    expect(mic).toContain("const level = this.muted ? 0 : rms(frame);\n    if (this.levels.size) emit(this.levels, level);");
  });
});
