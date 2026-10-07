import { describe, expect, it } from "vitest";
import { approvalDigest, approvalDigestInput } from "./approval-digest.ts";

const card = { title: "Run a command?", subtitle: "{\"command\":\"ls\"}", tool: "Bash", summary: "ls", options: ["Allow", "Deny"] };

describe("the approval digest", () => {
  it("is 64 lowercase hex and stable for the same card", async () => {
    const a = await approvalDigest("t1", "req-1", card);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await approvalDigest("t1", "req-1", { ...card })).toBe(a);
  });

  it("changes when any reviewed field changes", async () => {
    const base = await approvalDigest("t1", "req-1", card);
    for (const changed of [
      { ...card, subtitle: "{\"command\":\"ls -la\"}" },
      { ...card, title: "Run this?" },
      { ...card, tool: "Write" },
      { ...card, summary: "ls -la" },
      { ...card, held: "outside its folder" },
      { ...card, toolInputTruncated: true },
      { ...card, approvalScope: "local-computer" as const },
      { ...card, taskAllowKey: "delete:/Users/x/Documents" },
    ]) expect(await approvalDigest("t1", "req-1", changed)).not.toBe(base);
    expect(await approvalDigest("t2", "req-1", card)).not.toBe(base);
    expect(await approvalDigest("t1", "req-2", card)).not.toBe(base);
  });

  it("binds the displayed skill request: source, preview and hash", async () => {
    const skill = { source: "from a chat", preview: "# Skill\nDo A", sha256: "a".repeat(64) };
    const base = await approvalDigest("t1", "req-1", { ...card, skillRequest: skill });
    expect(base).not.toBe(await approvalDigest("t1", "req-1", card));
    for (const changed of [{ ...skill, preview: "# Skill\nDo B" }, { ...skill, source: "elsewhere" }, { ...skill, sha256: "b".repeat(64) }])
      expect(await approvalDigest("t1", "req-1", { ...card, skillRequest: changed })).not.toBe(base);
    // fields the owner does not review stay out of the binding
    expect(await approvalDigest("t1", "req-1", { ...card, skillRequest: { ...skill, createdAt: 5, gist: "x", stagedId: "s" } })).toBe(base);
  });

  it("binds the skill card's name, action and warnings", async () => {
    const skill = { source: "from a chat", preview: "# Skill", sha256: "a".repeat(64), name: "tidy-notes", action: "create", warnings: ["Runs a script."] };
    const base = await approvalDigest("t1", "req-1", { ...card, skillRequest: skill });
    for (const changed of [
      { ...skill, name: "tidy-other" },
      { ...skill, action: "update" },
      { ...skill, warnings: ["Runs a script.", "Reads your files."] },
      { ...skill, warnings: [] },
      { ...skill, warnings: undefined },
    ]) expect(await approvalDigest("t1", "req-1", { ...card, skillRequest: changed })).not.toBe(base);
  });

  it("binds a routine proposal's operation, whatever the key order", async () => {
    const operation = { action: "create", routine: { name: "Digest", schedule: { every: "day" }, prompt: "Send it" } };
    const base = await approvalDigest("t1", "req-1", { ...card, routineRequest: { operation } });
    expect(base).not.toBe(await approvalDigest("t1", "req-1", card));
    for (const changed of [
      { action: "create", routine: { name: "Digest", schedule: { every: "day" }, prompt: "Send it elsewhere" } },
      { action: "create", routine: { name: "Digest", schedule: { every: "hour" }, prompt: "Send it" } },
      { action: "delete", routineId: "r1" },
    ]) expect(await approvalDigest("t1", "req-1", { ...card, routineRequest: { operation: changed } })).not.toBe(base);
    const reordered = { routine: { prompt: "Send it", schedule: { every: "day" }, name: "Digest" }, action: "create" };
    expect(await approvalDigest("t1", "req-1", { ...card, routineRequest: { operation: reordered, requestId: "x" } })).toBe(base);
  });

  it("ignores fields that are not part of what the owner reviews", async () => {
    const base = await approvalDigest("t1", "req-1", card);
    expect(await approvalDigest("t1", "req-1", { ...card, answered: "allow", dismissed: true, pushBody: "x", allowKey: "Bash:ls" } as never)).toBe(base);
  });

  it("has a fixed, versioned canonical input", () => {
    expect(approvalDigestInput("t1", "req-1", { title: "A", subtitle: "B" })).toBe(
      JSON.stringify(["murage-approval-digest/2", "t1", "req-1", null, "A", "B", null, null, false, null, null, null, null, null, null, null, null, null]),
    );
  });

  it("digests multi-byte text as UTF-8 and treats non-string fields as absent", async () => {
    const wide = { ...card, title: "Delete caf\u00e9 \u{1F4C1}?" };
    expect(approvalDigestInput("t1", "req-1", wide)).toContain("caf\u00e9 \u{1F4C1}");
    expect(await approvalDigest("t1", "req-1", wide)).not.toBe(await approvalDigest("t1", "req-1", card));
    const base = await approvalDigest("t1", "req-1", card);
    // a number, an object or a string "true" is never the real thing
    expect(await approvalDigest("t1", "req-1", { ...card, held: 5, taskAllowKey: {} })).toBe(await approvalDigest("t1", "req-1", { ...card, held: undefined, taskAllowKey: undefined }));
    expect(await approvalDigest("t1", "req-1", { ...card, toolInputTruncated: "true" })).toBe(base);
    expect(approvalDigestInput("t1", "req-1", { ...card, title: 5 })).toContain("null");
    expect(await approvalDigest("t1", "req-1", { ...card, held: "" })).not.toBe(await approvalDigest("t1", "req-1", { ...card, held: undefined }));
  });
});
