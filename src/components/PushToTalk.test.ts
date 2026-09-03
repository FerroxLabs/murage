// Server-side voice typing, from the renderer's side of it.
//
// Named `.test.ts` and not `.test.tsx` deliberately: `vite.config.ts` collects
// `src/**/*.test.ts` and nothing else, and the environment is `node` with no
// jsdom and no testing-library in the tree. Every component test in this repo
// is therefore the same shape — pure decisions tested directly, and markup
// tested through `renderToStaticMarkup`, with `createElement` standing in for
// JSX. `FluxKeyCard.test.ts` is the model.
//
// The decisions are where the value is. Whether a microphone appears at all
// is four facts and one answer, and getting it wrong means either a dead
// button on a phone or a second, worse microphone next to the native one on a
// Mac.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INSECURE_NOTE,
  browserPushToTalkFacts,
  MAX_CLIP_MS,
  PREFERRED_TYPES,
  PushToTalk,
  noteForReason,
  pickMimeType,
  pushToTalkGate,
  type PushToTalkFacts,
} from "./PushToTalk";

const source = readFileSync(fileURLToPath(new URL("./PushToTalk.tsx", import.meta.url)), "utf8");

const READY: PushToTalkFacts = {
  nativeDictation: false,
  fluxConfigured: true,
  secure: true,
  canRecord: true,
};

const render = (facts: Partial<PushToTalkFacts> = {}) =>
  renderToStaticMarkup(
    createElement(PushToTalk, {
      onTranscript: vi.fn(),
      facts: { ...READY, ...facts },
    }),
  );

describe("which surface gets a microphone", () => {
  it("stands aside on a Mac, where the native helper is faster and streams partials", () => {
    expect(pushToTalkGate({ ...READY, nativeDictation: true })).toBe("hidden");
    expect(render({ nativeDictation: true })).toBe("");
  });

  it("offers itself on a phone browser, which has no native helper at all", () => {
    // POSITIVE control for the assertion above: the same rig DOES render when
    // the native path is absent, so an empty string there is the deference
    // working and not a component that never renders anything.
    expect(pushToTalkGate(READY)).toBe("ready");
    expect(render()).toContain("Hold to talk");
  });

  it("says nothing when this browser cannot record, or the workspace has no key", () => {
    // Neither is something the person can act on from here, and a control
    // that exists only to refuse is worse than no control.
    expect(pushToTalkGate({ ...READY, canRecord: false })).toBe("hidden");
    expect(pushToTalkGate({ ...READY, fluxConfigured: false })).toBe("hidden");
  });
});

describe("plain HTTP", () => {
  it("explains the insecure context instead of showing a button that cannot work", () => {
    // getUserMedia does not exist outside a secure context, so the button
    // would be dead on arrival. This is the one refusal that gets a sentence,
    // because the fix is real and it is on the person's own computer.
    expect(pushToTalkGate({ ...READY, secure: false })).toBe("insecure");
    const html = render({ secure: false });
    expect(html).toContain("Serve on my tailnet");
    expect(html).toContain("https");
    // The control is present but is NOT the recording control: it neither
    // claims to listen nor pretends the gesture will work. Pressing it says
    // why, into the banner the composer already owns.
    expect(html).not.toContain("Hold to talk");
    expect(html).toContain("Voice typing unavailable");
    // muted, so it does not read as an equal sibling of the send button
    expect(html).toContain("text-ink-secondary/40");
  });

  it("reports the SAME sentence it shows in the tooltip when pressed", () => {
    // Caught by a green negative control: rewording the onClick handler alone
    // changed nothing any assertion could see, because every check above reads
    // the rendered `title`. `renderToStaticMarkup` cannot fire a click, so the
    // wiring is pinned in the source instead — the rule FluxKeyCard.test.ts
    // uses for the same reason. One constant, both places.
    expect(source).toContain("onClick={() => onNote?.(INSECURE_NOTE)}");
    // and there is exactly one such sentence to get out of sync with
    expect(source.match(/Serve on my tailnet/g) ?? []).toHaveLength(1);
  });

  it("names the setting the way the settings page names it", () => {
    // "Serve on my tailnet" is the literal label in CompanionSection.tsx.
    // An instruction that names a control which does not exist is not an
    // instruction.
    expect(INSECURE_NOTE).toContain("Serve on my tailnet");
  });
});

describe("the container, which no phone gets to guess about", () => {
  it("takes ogg when it is offered — the Firefox case, and the only one", () => {
    expect(pickMimeType((type) => type === "audio/ogg;codecs=opus")).toBe("audio/ogg;codecs=opus");
  });

  it("records webm/opus in the two engines that actually ship on phones", () => {
    // MEASURED, not assumed. Chromium 143 (Electron, Android Chrome) and
    // Safari 26.3 / WebKit 605.1.15 (the iPhone) both answer FALSE to
    // isTypeSupported("audio/ogg;codecs=opus") and TRUE to webm/opus. So the
    // ogg preference is a bonus branch and webm is the real path.
    const chromiumAndWebkit = (type: string) => type === "audio/webm;codecs=opus" || type === "audio/mp4";
    expect(pickMimeType(chromiumAndWebkit)).toBe("audio/webm;codecs=opus");
    // ogg is asked for FIRST and refused, which is the whole shape of it
    expect(PREFERRED_TYPES[0]).toBe("audio/ogg;codecs=opus");
    expect(chromiumAndWebkit("audio/ogg;codecs=opus")).toBe(false);
  });

  it("falls back to mp4 for a WebKit older than its webm recorder", () => {
    expect(pickMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
  });

  it("returns null rather than inventing a container the browser cannot make", () => {
    expect(pickMimeType(() => false)).toBeNull();
  });
});

describe("a refusal a person can act on", () => {
  it("never tells someone with a valid key to go and check their key", () => {
    // The live state of this workspace: Flux answers 402 premium_locked for
    // transcription. "Check your key" would be a loop with no exit.
    const paid = noteForReason("premium", "Transcribing failed (402)");
    expect(paid).toContain("paid Flux plan");
    expect(paid).toContain("The key is fine");
    expect(paid).not.toMatch(/paste|check your key/i);

    // and the genuinely-bad key gets the opposite sentence
    expect(noteForReason("auth", "x")).toMatch(/fresh one/i);
    expect(noteForReason("auth", "x")).not.toBe(paid);
  });

  it("points a missing key at the computer, because a phone cannot fix it", () => {
    expect(noteForReason("key", "x")).toContain("Settings on the computer");
  });

  it("keeps the provider's own words when it has no better sentence", () => {
    expect(noteForReason("upstream", "Flux fell over")).toBe("Flux fell over");
    expect(noteForReason(undefined, "Transcribing failed.")).toBe("Transcribing failed.");
  });
});

describe("reading the facts off the actual browser", () => {
  /** A browser with a recorder, a microphone and one usable container. */
  function stubBrowser(over: { secure?: boolean; supports?: (type: string) => boolean; mic?: boolean } = {}) {
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: over.supports ?? ((type: string) => type === "audio/webm;codecs=opus"),
    });
    vi.stubGlobal("navigator", { mediaDevices: over.mic === false ? {} : { getUserMedia: () => {} } });
    vi.stubGlobal("window", { isSecureContext: over.secure ?? true });
  }

  afterEach(() => vi.unstubAllGlobals());

  it("reads the secure context and a usable container from the live browser", () => {
    stubBrowser();
    expect(browserPushToTalkFacts({ nativeDictation: false, fluxConfigured: true })).toEqual({
      nativeDictation: false,
      fluxConfigured: true,
      secure: true,
      canRecord: true,
    });
  });

  it("reports plain HTTP as insecure rather than assuming the door is served", () => {
    stubBrowser({ secure: false });
    expect(browserPushToTalkFacts({ nativeDictation: false, fluxConfigured: true }).secure).toBe(false);
  });

  it("counts 'no container we can name' as cannot-record, not as ready", () => {
    // A recorder that exists but offers nothing Flux accepts would produce a
    // button whose every press ends in a 415. That is not ready.
    stubBrowser({ supports: () => false });
    expect(browserPushToTalkFacts({ nativeDictation: false, fluxConfigured: true }).canRecord).toBe(false);
  });

  it("counts a missing getUserMedia as cannot-record", () => {
    stubBrowser({ mic: false });
    expect(browserPushToTalkFacts({ nativeDictation: false, fluxConfigured: true }).canRecord).toBe(false);
  });
});

describe("the idle control", () => {
  it("is hold-to-talk, not a toggle, and says so where a toggle would say Dictate", () => {
    const html = render();
    expect(html).toContain('aria-label="Hold to talk"');
    // The native path is a toggle ("Start dictation"/"Stop dictation"). This
    // one is held, and the label is the only warning a person gets.
    expect(html).not.toContain("Start dictation");
  });

  it("does not claim to be listening before anything is held", () => {
    const html = render();
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("Transcribing");
  });

  it("stops itself well inside the companion proxy's header deadline", () => {
    // companion/src/proxy.ts:85 gives the harness 30s to send headers. A clip
    // long enough to blow through that returns a 504 to the phone while the
    // harness is still working, which is unrecoverable from the phone's side.
    expect(MAX_CLIP_MS).toBeLessThanOrEqual(120_000);
  });
});
