import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startCall, endCall } from "./call";
import { CODE_OMITTED, canReadAloud, readAloudLabel, readAloudText, toggleReadAloud } from "./read-aloud";
import { speaker as windowSpeaker, Speaker } from "./tts";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe("what is read aloud", () => {
  it("leaves plain prose alone", () => {
    expect(readAloudText("All three checks passed.")).toBe("All three checks passed.");
  });

  it("skips a code block and says code omitted instead", () => {
    const text = "Here is the fix.\n\n```ts\nconst a = 1;\nconsole.log(a);\n```\n\nRun it again.";
    const spoken = readAloudText(text);
    expect(spoken).not.toContain("const a");
    expect(spoken).not.toContain("console");
    expect(spoken).toContain(CODE_OMITTED);
    expect(spoken).toContain("Here is the fix.");
    expect(spoken).toContain("Run it again.");
  });

  it("says it once, however many blocks there are", () => {
    const text = "One.\n```\na\n```\nTwo.\n~~~sh\nls\n~~~\nThree.\n```py\nprint(1)\n```";
    const spoken = readAloudText(text);
    expect(spoken.split(CODE_OMITTED)).toHaveLength(2);
    expect(spoken).not.toMatch(/print|ls\b/);
  });

  it("omits a block that never closes", () => {
    const spoken = readAloudText("Starting.\n```js\nlet x = 1;\nlet y = 2;");
    expect(spoken).toContain(CODE_OMITTED);
    expect(spoken).not.toContain("let x");
  });

  it("omits tool output blocks the same way", () => {
    const spoken = readAloudText("Ran it.\n<tool_output>\nexit 0\nsome log line\n</tool_output>\nDone.");
    expect(spoken).not.toContain("some log line");
    expect(spoken).toContain(CODE_OMITTED);
  });

  it("omits indented code blocks (four spaces or a tab)", () => {
    const spoken = readAloudText("Try this:\n\n    npm install\n    npm test\n\nThen tell me.");
    expect(spoken).not.toContain("npm");
    expect(spoken).toContain(CODE_OMITTED);
    expect(spoken).toContain("Then tell me.");
    expect(readAloudText("Run:\n\n\tls -la\n\tpwd\n\nDone.")).not.toContain("ls -la");
    // one note across fenced and indented code together
    const both = readAloudText("A.\n\n    x = 1\n\nB.\n```\ny\n```\nC.");
    expect(both.split(CODE_OMITTED)).toHaveLength(2);
  });

  it("keeps an indented list continuation as prose", () => {
    const spoken = readAloudText("- first item\n    continues here with words\n- second item");
    expect(spoken).toContain("continues here");
    expect(spoken).not.toContain(CODE_OMITTED);
  });

  it("is only the omission note for a reply that is all code", () => {
    expect(readAloudText("```\nonly code\n```")).toBe(CODE_OMITTED);
  });

  it("reads only text messages", () => {
    expect(canReadAloud({ kind: "text", text: "hi" })).toBe(true);
    expect(canReadAloud({ kind: "activity", text: "hi" })).toBe(false);
    expect(canReadAloud({ kind: "text", text: "  " })).toBe(false);
  });
});

describe("the control", () => {
  it("is Read aloud, and Stop while playing", () => {
    expect(readAloudLabel({ playing: false, ready: true })).toBe("Read aloud");
    expect(readAloudLabel({ playing: true, ready: true })).toBe("Stop");
  });

  it("names what a missing voice needs, once an endpoint exists", () => {
    expect(readAloudLabel({ playing: false, ready: false })).toMatch(/voice/i);
  });
});

describe("toggleReadAloud", () => {
  const message = { text: "Hello.\n```\ncode\n```", botId: "bot_1", messageId: "m1", voiceId: "nova" };

  it("speaks with that bot's own voice and the code omitted", () => {
    const fake = { state: { status: "idle" as const }, speak: vi.fn(async () => {}), stop: vi.fn() };
    toggleReadAloud(fake as never, message);
    expect(fake.speak).toHaveBeenCalledWith(`Hello.\n${CODE_OMITTED}`, { botId: "bot_1", messageId: "m1", voiceId: "nova" });
  });

  it("stops when this message is the one playing", () => {
    const fake = { state: { status: "speaking" as const, messageId: "m1" }, speak: vi.fn(), stop: vi.fn() };
    toggleReadAloud(fake as never, message);
    expect(fake.stop).toHaveBeenCalled();
    expect(fake.speak).not.toHaveBeenCalled();
  });

  it("starts this one when another message is playing", () => {
    const fake = { state: { status: "speaking" as const, messageId: "other" }, speak: vi.fn(async () => {}), stop: vi.fn() };
    toggleReadAloud(fake as never, message);
    expect(fake.speak).toHaveBeenCalled();
  });
});

describe("one at a time, on the real speaker", () => {
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onplaying: (() => void) | null = null;
    ontimeupdate: (() => void) | null = null;
    onpause: (() => void) | null = null;
    pause = vi.fn();
    play = vi.fn(async () => {});
    constructor(public src: string) {}
  }
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:read-aloud");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? new Response(JSON.stringify({ ready: true, utterances: ["A sentence."] }), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
  });

  const live: Speaker[] = [];
  afterEach(() => {
    // nothing may keep playing, or fetching, once the globals are put back
    for (const sp of live.splice(0)) sp.stop();
    vi.unstubAllGlobals();
  });
  const speakerForTest = () => {
    const sp = new Speaker();
    live.push(sp);
    return sp;
  };

  it("starting another message's read-aloud stops the current one", async () => {
    const sp = speakerForTest();
    toggleReadAloud(sp, { text: "First reply.", botId: "b", messageId: "m1" });
    await vi.waitFor(() => expect(sp.state.messageId).toBe("m1"));
    toggleReadAloud(sp, { text: "Second reply.", botId: "b", messageId: "m2" });
    await vi.waitFor(() => expect(sp.state.messageId).toBe("m2"));
    expect(sp.isSpeaking("m1")).toBe(false);
    expect(sp.isSpeaking("m2")).toBe(true);
  });

  it("the same control stops it", async () => {
    const sp = speakerForTest();
    toggleReadAloud(sp, { text: "First reply.", botId: "b", messageId: "m1" });
    await vi.waitFor(() => expect(sp.state.status).not.toBe("idle"));
    toggleReadAloud(sp, { text: "First reply.", botId: "b", messageId: "m1" });
    expect(sp.state).toEqual({ status: "idle" });
  });

  it("a call starting stops it", () => {
    vi.stubGlobal("window", { muragebox: { speechStop: vi.fn(async () => {}) } });
    const stop = vi.spyOn(windowSpeaker, "stop");
    endCall();
    stop.mockClear();
    startCall("bot-x");
    expect(stop).toHaveBeenCalled();
    endCall();
  });
});

describe("where it is offered", () => {
  const button = read("../components/SpeakButton.tsx");
  const chat = read("../components/ChatView.tsx");
  const group = read("../components/GroupView.tsx");

  it("is hidden when no voice endpoint is configured, by the call button's own check", () => {
    // CallControls gates on `state.config?.tts?.configured`; so does this.
    expect(button).toMatch(/tts\?\.configured/);
    expect(button).toMatch(/if \(!configured[^)]*\) return null/);
    expect(chat).toMatch(/tts\?\.configured/);
    expect(group).toMatch(/tts\?\.configured/);
  });

  it("is on every bot reply in a 1:1 chat and in a room, in the action row and the sheet", () => {
    expect(chat).toContain("<SpeakButton");
    expect(group).toContain("<SpeakButton");
    expect(group).toMatch(/id: "speak"/);
    expect(chat).toMatch(/id: "speak"/);
  });

  it("uses the bot's own voice", () => {
    expect(chat).toMatch(/<SpeakButton[^>]*voiceId=\{bot\.voice\}/);
    expect(group).toMatch(/<SpeakButton[^>]*voiceId=\{[^}]*voice\}/);
  });

  it("goes through the shared toggle, so the code is omitted everywhere", () => {
    expect(button).toContain("toggleReadAloud(");
    expect(chat).toContain("toggleReadAloud(");
    expect(group).toContain("toggleReadAloud(");
  });
});
