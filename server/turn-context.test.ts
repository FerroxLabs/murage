import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { openerAt } from "../shared/bot-openers.ts";
import {
  buildTurnContext,
  engineIsFresh,
  replaysTranscriptNatively,
  TRANSCRIPT_REPLAY_DRIVER_KINDS,
} from "./turn-context.ts";

const transcript = [
  { role: "user" as const, text: "my dog is named Biscuit" },
  { role: "assistant" as const, text: "Noted — Biscuit." },
];

describe("buildTurnContext", () => {
  it("passes text through untouched on a plain resumed turn", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: false, externallyUpdated: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: true });
  });

  it("replays inline on rewind, exactly like the existing behaviour", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: true, fresh: false, externallyUpdated: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("rewound this conversation");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("replays inline for a fresh engine with prior history — the model-switch fix", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: true, externallyUpdated: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound"); // distinct marker, distinct preamble
    expect(out.turnText).toContain("Assistant: Noted — Biscuit.");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("never wraps for native-replay drivers — they get history via SendTurnInput.transcript", () => {
    for (const flags of [
      { rewound: true, fresh: false, externallyUpdated: false },
      { rewound: false, fresh: true, externallyUpdated: false },
      { rewound: false, fresh: false, externallyUpdated: true },
    ]) {
      const out = buildTurnContext({ text: "hi", transcript, ...flags, replaysNatively: true });
      expect(out.turnText).toBe("hi");
      expect(out.resume).toBe(false);
    }
  });

  it("does not wrap a fresh engine on an empty thread — nothing to replay", () => {
    const out = buildTurnContext({ text: "hi", transcript: [], rewound: false, fresh: true, externallyUpdated: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: false });
  });

  it("replays an out-of-band teammate result before the next user turn", () => {
    const updated = [
      ...transcript,
      { role: "assistant" as const, text: "@Worker replied to the delegated task:\n\nfinished the report" },
    ];
    const out = buildTurnContext({
      text: "what did they find?",
      transcript: updated,
      rewound: false,
      fresh: false,
      externallyUpdated: true,
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("received an update outside your provider session");
    expect(out.turnText).toContain("@Worker replied to the delegated task");
    expect(out.turnText.endsWith("what did they find?")).toBe(true);
  });
});

describe("engineIsFresh", () => {
  const withUser = transcript;
  // the real seeded opener, not a copy of one: pinning the sentence is how
  // this fixture went stale the last time the greeting changed
  const greetingOnly = [{ role: "assistant" as const, text: openerAt(0, "Wren") }];

  it("is false when the same instance ran the last turn and has a cursor", () => {
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: "claude", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
  });

  it("is true when the same instance ran last but there is no cursor to resume", () => {
    expect(engineIsFresh({ instanceId: "pi", lastInstanceId: "pi", resumeCursors: {}, transcript: withUser })).toBe(true);
  });

  it("is true when another instance ran the last turn — even if this one has an older cursor", () => {
    // the user's bug: claude had a session from days ago, antigravity took the
    // latest turn, switching back to claude must NOT resume the stale session
    expect(
      engineIsFresh({ instanceId: "claude", lastInstanceId: "antigravity", resumeCursors: { claude: "old", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });

  it("is true for an instance that has never run this thread", () => {
    expect(engineIsFresh({ instanceId: "codex", lastInstanceId: "claude", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
  });

  it("is false on a brand-new bot: the seeded greeting alone is nothing to join", () => {
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: {}, transcript: greetingOnly })).toBe(false);
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: {}, transcript: [] })).toBe(false);
  });

  it("legacy task without lastInstanceId: trusts a lone cursor for this instance, replays otherwise", () => {
    // one cursor, ours — pre-upgrade single-engine thread, keep resuming
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
    // one cursor, someone else's — we never ran here
    expect(engineIsFresh({ instanceId: "codex", lastInstanceId: undefined, resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
    // two cursors — can't tell who ran last; replaying is the safe side
    expect(
      engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: { claude: "s1", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });
});

// Memory refresh must preserve authorized replay without inventing an owner edit.
it("replays refreshed memory without claiming a user rewind", () => {
  const result = buildTurnContext({ text: "continue", transcript: [{role: "user", text: "prior request"}], rewound: false, fresh: false, externallyUpdated: false, replaysNatively: false, memoryRefreshed: true });
  expect(result.resume).toBe(false);
  expect(result.turnText).toContain("authorized memory context was refreshed");
  expect(result.turnText).toContain("User: prior request");
  expect(result.turnText).not.toContain("The user rewound");
});

// W13: replaysNatively was hardcoded to "grok". It is not a property of xAI —
// it is a property of createOpenAIChatRuntime, which turns `turn.transcript`
// into chat `messages` on every turn. openai-compat and minimax were built on
// that same runtime and were never added, so on any context reset they got the
// branch twice: once as `messages` and once again embedded in the final user
// message. This reads the drivers rather than trusting a literal list.
describe("TRANSCRIPT_REPLAY_DRIVER_KINDS", () => {
  // Comments are stripped before matching, and only whole-line comments are
  // dropped so a URL's "//" survives. A previous source scan on this branch
  // matched prose and ended up enforcing the very claim it should have caught.
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  it("names exactly the drivers built on createOpenAIChatRuntime", () => {
    const dir = fileURLToPath(new URL("./drivers/", import.meta.url));
    const found = new Set<string>();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.includes(".test.") || name === "openai-chat.ts") continue;
      const code = stripComments(readFileSync(join(dir, name), "utf8"));
      if (!code.includes("createOpenAIChatRuntime(")) continue;
      const kind = /const\s+DRIVER_KIND\s*=\s*"([^"]+)"/.exec(code)?.[1];
      expect(kind, `${name} calls createOpenAIChatRuntime but declares no DRIVER_KIND`).toBeTruthy();
      found.add(kind!);
    }
    expect(found.size).toBeGreaterThan(1);
    expect([...found].sort()).toEqual([...TRANSCRIPT_REPLAY_DRIVER_KINDS].sort());
  });

  it("stops a transcript-replay driver being sent the branch twice", () => {
    for (const kind of TRANSCRIPT_REPLAY_DRIVER_KINDS) {
      expect(replaysTranscriptNatively(kind)).toBe(true);
      const out = buildTurnContext({
        text: "hi", transcript, rewound: false, fresh: true,
        externallyUpdated: false, replaysNatively: replaysTranscriptNatively(kind),
      });
      expect(out.turnText, `${kind} embedded the branch in turnText as well`).toBe("hi");
    }
    expect(replaysTranscriptNatively("claudeAgent")).toBe(false);
  });
});
