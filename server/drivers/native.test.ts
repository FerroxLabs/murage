// The native tee is the file people paste into bug reports, so the wiring
// that keeps credentials out of it is tested at the writer — redact.test.ts
// covers the masking function, this covers that appendNative actually calls it.
// (server/testing/setup.ts points HOME at a throwaway dir, so NATIVE_DIR is
// already isolated from the real fleet.)
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
const { appendNative, withholdNativeThread } = await import(process.env.MURAGE_NATIVE_LOG_CONTROL_ENTRY ?? "./native.ts") as typeof import("./native.ts");
import { renderDriverReplay } from "../turn-context.ts";

beforeAll(() => ensureDirs());

describe("appendNative", () => {
  const recordLimit = 64 * 1024;
  const segmentLimit = 4 * 1024 * 1024;
  const filesFor = (thread: string) => readdirSync(NATIVE_DIR).filter((file) => file.startsWith(`${thread}.`) && file.endsWith(".ndjson"));
  const recordsFor = (thread: string) => filesFor(thread).flatMap((file) => {
    const path = join(NATIVE_DIR, file);
    expect(statSync(path).size).toBeLessThanOrEqual(segmentLimit);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => {
      expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(recordLimit);
      return JSON.parse(line);
    });
  });

  it("09-A5: a credential streamed across partial-message deltas cannot be rebuilt from the stored frames", () => {
    const thread = "t-stream-split-key";
    const frame = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
    for (const piece of ["Your key is ", "sk-ant-", "api03-AbCdEf01", "23456789xyzXYZ0123456789", " done"]) appendNative(thread, { dir: "in", source: "fixture", msg: frame(piece) });
    const file = readFileSync(join(NATIVE_DIR, `${thread}.ndjson`), "utf8");
    expect(file).not.toContain("AbCdEf01");
    expect(file).not.toContain("xyzXYZ");
    // sink allowlist (MurageMain 11-06; was: the prose around the key is kept): a delta's text is never written, its frame is
    const rows = file.trimEnd().split("\n").map((line) => JSON.parse(line).msg);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row).toEqual({ type: "stream_event", event: { type: "content_block_delta", index: 0 } });
  });

  // GrokBuild case 20: a tool or command frame in the native trace goes through the L1 projection (no command, no input
  // text, paths and ids kept); every other frame is unchanged.
  it("Grok case 20 (Grok's row): a native row whose msg.command is SECRET omits it", () => {
    const SECRET = "confidential-plan-text-7f3a";
    appendNative("t-native-cmd", { dir: "in", source: "fixture", msg: { command: SECRET } });
    expect(readFileSync(join(NATIVE_DIR, "t-native-cmd.ndjson"), "utf8")).not.toContain(SECRET);
  });

  it("Grok case 20 + sink allowlist: Codex, ACP, Claude, pi, openai-chat and BoxAgent frames keep ids and paths only; a reply's text is not written either", () => {
    const SECRET = "confidential-plan-text-7f3a";
    const thread = "t-native-tool-frames";
    const frames: unknown[] = [
      { method: "item/started", params: { threadId: "th-1", turnId: "tu-1", item: { type: "commandExecution", id: "call_1", command: `cat ${SECRET}`, cwd: "/w", status: "inProgress", commandActions: [{ type: "unknown", command: SECRET }] } } },
      { method: "item/completed", params: { item: { type: "commandExecution", id: "call_1", command: SECRET, aggregatedOutput: SECRET, exitCode: 0 } } },
      { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th-1", itemId: "call_1", command: SECRET, cwd: "/w", reason: `run ${SECRET}` } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: SECRET, kind: "execute", status: "pending", rawInput: { command: SECRET, cwd: "/w" }, content: [{ type: "content", content: { type: "text", text: SECRET } }], locations: [{ path: "/w/a.md" }] } } },
      { jsonrpc: "2.0", id: 3, method: "session/request_permission", params: { sessionId: "s-1", toolCall: { toolCallId: "tc-1", title: SECRET, kind: "execute", rawInput: { command: SECRET } }, options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ordinary reply" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: SECRET, description: SECRET } }] } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: `{"command":"${SECRET}"}` } } },
      { type: "tool_execution_start", toolCallId: "p-1", toolName: "bash", args: { command: SECRET } },
      { choices: [{ message: { tool_calls: [{ id: "c-1", type: "function", function: { name: "computer__run", arguments: JSON.stringify({ cmd: SECRET, cwd: "/w" }) } }] } }] },
      { type: "command", id: "box-1", title: SECRET, command: SECRET },
      { tool_name: "run_command", tool_input: { CommandLine: SECRET, Cwd: "/w" } },
    ];
    for (const msg of frames) appendNative(thread, { dir: "in", source: "fixture", msg });
    appendNative(thread, { dir: "in", source: "fixture", msg: { type: "assistant", text: "an ordinary reply", usage: { input_tokens: 3 } } });
    const text = readFileSync(join(NATIVE_DIR, `${thread}.ndjson`), "utf8");
    expect(text).not.toContain(SECRET);
    const rows = text.trimEnd().split("\n").map((line) => JSON.parse(line).msg);
    expect(rows[0].params.item).toEqual({ type: "commandExecution", id: "call_1", cwd: "/w", status: "inProgress" });
    expect(rows[1].params.item).toEqual({ type: "commandExecution", id: "call_1", exitCode: 0 });
    expect(rows[2]).toMatchObject({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th-1", itemId: "call_1", cwd: "/w" } });
    expect(rows[3].params.update).toEqual({ sessionUpdate: "tool_call", toolCallId: "tc-1", kind: "execute", status: "pending", rawInput: { cwd: "/w" }, locations: [{ path: "/w/a.md" }] });
    expect(rows[4].params.options).toEqual([{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]);
    expect(rows[5].message.content).toEqual([{ type: "text" }, { type: "tool_use", id: "toolu_1", name: "Bash" }]);
    expect(rows[7]).toEqual({ type: "tool_execution_start", toolCallId: "p-1", toolName: "bash" });
    expect(JSON.parse(rows[8].choices[0].message.tool_calls[0].function.arguments)).toEqual({ cwd: "/w" });
    expect(rows.at(-1)).toEqual({ type: "assistant", usage: { input_tokens: 3 } });
    expect(text).not.toContain("ordinary reply");
  });

  it("bounds repeated multibyte and image-heavy records and keeps a recent ordinary reply", () => {
    const thread = "t-size-limits";
    // sink allowlist (MurageMain 11-06): text and image bytes are never written, so the oversize rows are made of what a row
    // keeps (numbers); the record cap is exercised exactly as before
    for (let i = 0; i < 12; i++) {
      appendNative(thread, { dir: "in", source: "fixture", msg: { sizes: Array.from({ length: 8_000 }, () => 1234567890), index: i, text: "界".repeat(25_000) } });
      appendNative(thread, { dir: "in", source: "fixture", msg: { type: "image", data: "A".repeat(100_000) } });
    }
    appendNative(thread, { dir: "in", source: "fixture", msg: { index: 99, text: "recent ordinary reply" } });
    const records = recordsFor(thread);
    expect(records.filter((record) => record.msg.type === "native_trace_record_omitted")).toHaveLength(12);
    expect(records.filter((record) => record.msg.type === "image")).toHaveLength(12);
    expect(records.at(-1).msg).toEqual({ index: 99 });
    expect(records.some((record) => record.msg.data || record.msg.text)).toBe(false);
  });

  it("retains at most two segments per interleaved thread and keeps recent records on repeated rotation", () => {
    for (let index = 0; index < 420; index++) {
      for (const thread of ["t-rotation-a", "t-rotation-b"]) {
        // sink allowlist: the 30 KB filler is numbers (text is not written); the thread rides in an id field
        appendNative(thread, { dir: "in", source: "fixture", msg: { index, threadId: thread, sizes: Array.from({ length: 3_000 }, () => 1234567890) } });
      }
    }
    for (const thread of ["t-rotation-a", "t-rotation-b"]) {
      expect(filesFor(thread).sort()).toEqual([`${thread}.ndjson`, `${thread}.previous.ndjson`]);
      const records = recordsFor(thread);
      expect(records.some((record) => record.msg.type === "native_trace_retention")).toBe(true);
      expect(records.some((record) => record.msg.index === 419 && record.msg.threadId === thread)).toBe(true);
      expect(records.some((record) => record.msg.threadId && record.msg.threadId !== thread)).toBe(false);
      expect(filesFor(thread).reduce((total, file) => total + statSync(join(NATIVE_DIR, file)).size, 0)).toBeLessThanOrEqual(2 * segmentLimit);
    }
  });

  it("bounds existing oversized segments while retaining valid recent records", () => {
    const thread = "t-legacy-large";
    const legacy = JSON.stringify({ msg: { text: "z".repeat(segmentLimit + 1024) } }) + "\n"
      + JSON.stringify({ msg: { text: "legacy recent" } }) + "\n";
    writeFileSync(join(NATIVE_DIR, `${thread}.ndjson`), legacy, { mode: 0o644 });
    writeFileSync(join(NATIVE_DIR, `${thread}.previous.ndjson`), legacy, { mode: 0o644 });
    appendNative(thread, { dir: "in", source: "fixture", msg: { id: "new-recent", text: "new recent" } });
    const records = recordsFor(thread);
    expect(records.some((record) => record.msg.text === "legacy recent")).toBe(true);
    // sink allowlist: the new row is written without its text
    expect(records.some((record) => record.msg.id === "new-recent" && record.msg.text === undefined)).toBe(true);
    expect(records.some((record) => record.msg.type === "native_trace_retention")).toBe(true);
  });

  it("contains filesystem failures without breaking the provider", () => {
    const thread = "t-write-failure";
    mkdirSync(join(NATIVE_DIR, `${thread}.ndjson`));
    expect(() => appendNative(thread, { dir: "in", source: "fixture", msg: { text: "not written" } })).not.toThrow();
    expect(existsSync(join(NATIVE_DIR, `${thread}.previous.ndjson`))).toBe(false);
    const blockedRotation = "t-rotation-failure";
    writeFileSync(join(NATIVE_DIR, `${blockedRotation}.ndjson`), " ".repeat(segmentLimit - 100));
    mkdirSync(join(NATIVE_DIR, `${blockedRotation}.previous.ndjson`));
    expect(() => appendNative(blockedRotation, { dir: "in", source: "fixture", msg: { text: "x".repeat(200) } })).not.toThrow();
  });
  it("masks the tokens an ACP session/new hands the agent", () => {
    appendNative("t-native", {
      dir: "out",
      source: "acp",
      msg: {
        method: "session/new",
        params: {
          mcpServers: [
            {
              name: "computer",
              env: [
                { name: "MURAGEBOX_BOX_ID", value: "box-7" },
                { name: "MURAGEBOX_BOX_TOKEN", value: "box_live_dontlogme" },
              ],
            },
          ],
        },
      },
    });

    const log = readFileSync(join(NATIVE_DIR, "t-native.ndjson"), "utf8");
    expect(log).not.toContain("box_live_dontlogme");
    // the shape a debugger needs is still there: which server, which var
    expect(log).toContain("session/new");
    expect(log).toContain("MURAGEBOX_BOX_TOKEN");
    // sink allowlist (was: toContain("box-7")): an env value is never written, a secret or not
    expect(log).not.toContain("box-7");
  });

  it("keeps bare xAI, Groq and Hugging Face keys in an ordinary reply out, and the prose too (sink allowlist)", () => {
    // Synthetic fixtures assembled at runtime (#987); never real keys.
    const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const keys = [`${"xa" + "i-"}${alnum.slice(0, 24)}`, `${"gs" + "k_"}${alnum.slice(0, 40)}`, `${"h" + "f_"}${alnum.slice(0, 30)}`];
    appendNative("t-bare-keys", {
      dir: "in",
      source: "acp",
      msg: { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `Try ${keys.join(" then ")} tomorrow.` } } } },
    });

    const log = readFileSync(join(NATIVE_DIR, "t-bare-keys.ndjson"), "utf8");
    for (const key of keys) expect(log).not.toContain(key);
    // sink allowlist (was: the redacted prose is kept): the reply chunk's text is never written
    expect(log).not.toContain("tomorrow");
    expect(JSON.parse(log.trimEnd()).msg).toEqual({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } });
  });

  it("writes the log private to the user", () => {
    appendNative("t-mode", { dir: "in", source: "acp", msg: { hello: "world" } });
    const mode = statSync(join(NATIVE_DIR, "t-mode.ndjson")).mode & 0o777;
    // Windows does not implement POSIX modes; everywhere else, owner-only
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("keeps lifecycle ids intact: a digit run inside a UUID is not a secret number", () => {
    // The last one's tail reads as a Luhn-valid card number (4111 1111 1111 1111) to the financial-id rule.
    const ids = ["fb296783-4baa-4128-831c-b46042fa7ced", "40784341-8049-46ee-9f0b-fb6dcf07132f", "12345678-9012-4345-8678-901234567890", "fb296783-4baa-4cde-4111-111111111111"];
    for (const id of ids) {
      appendNative("t-lifecycle-ids", { dir: "lifecycle", source: "murage.engine-lifecycle", msg: { event: "mcp_ready_own", turnId: id, processGeneration: id } });
    }
    const rows = readFileSync(join(NATIVE_DIR, "t-lifecycle-ids.ndjson"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.msg.turnId)).toEqual(ids);
    expect(rows.map((row) => row.msg.processGeneration)).toEqual(ids);
    // Only the harness id fields are kept as written; the same digits anywhere else are still masked.
    appendNative("t-lifecycle-ids-other", { dir: "lifecycle", source: "murage.engine-lifecycle", msg: { event: "mcp_ready_own", turnId: ids[3], detail: "card 4111 1111 1111 1111" } });
    const other = JSON.parse(readFileSync(join(NATIVE_DIR, "t-lifecycle-ids-other.ndjson"), "utf8").trimEnd());
    expect(other.msg.turnId).toBe(ids[3]);
    expect(other.msg.detail).not.toContain("4111 1111 1111 1111");
  });

  it("never throws, whatever it is handed", () => {
    expect(() => appendNative("t-bad", { dir: "in", source: "acp", msg: undefined })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => appendNative("t-cyclic", { dir: "in", source: "acp", msg: cyclic })).not.toThrow();
  });

  describe("1.0.9 phone tools S19: a marked thread keeps no text in the native trace", () => {
    const WITHHELD = "[phone thread text withheld]";
    const rows = (thread: string) => readFileSync(join(NATIVE_DIR, `${thread}.ndjson`), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    const SECRET_WORDS = "Dr Lee at 9 in Room 4, bring the numbers";
    beforeAll(() => withholdNativeThread((threadId) => threadId.startsWith("t-marked-")));

    it("an out frame carrying a replay prompt with Assistant lines is written without the phone text", () => {
      const prompt = renderDriverReplay([{ role: "user", text: "what is on my calendar" }, { role: "assistant", text: SECRET_WORDS }]);
      appendNative("t-marked-replay", { dir: "out", source: "claude", msg: { type: "user", prompt, turn: 3, flag: true } });
      const log = readFileSync(join(NATIVE_DIR, "t-marked-replay.ndjson"), "utf8");
      expect(log).not.toContain("Dr Lee");
      expect(log).not.toContain("what is on my calendar");
      const row = rows("t-marked-replay")[0];
      // sink allowlist: the prompt is not written at all (was: prompt: WITHHELD)
      expect(row.msg).toEqual({ type: WITHHELD, turn: 3, flag: true });
      expect(row.dir).toBe("out");
      expect(row.source).toBe("claude");
      expect(typeof row.at).toBe("string");
    });

    it("an in raw claude SDK frame and every driver source label are withheld at any depth, numbers kept", () => {
      for (const source of ["claude", "codex", "boxagent", "antigravity"]) {
        const thread = `t-marked-${source}`;
        appendNative(thread, { dir: "in", source, msg: { type: "assistant", usage: { input_tokens: 12, output_tokens: 34 }, message: { content: [{ type: "text", text: SECRET_WORDS }, { type: "tool_use", input: { q: SECRET_WORDS } }] }, list: [SECRET_WORDS, 7, null] } });
        expect(readFileSync(join(NATIVE_DIR, `${thread}.ndjson`), "utf8")).not.toContain("Dr Lee");
        const row = rows(thread)[0];
        expect(row.source).toBe(source);
        expect(row.msg.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
        // sink allowlist: text is not written at all, so the withheld row has no text key and the list keeps its numbers
        expect(row.msg.message.content[0]).toEqual({ type: WITHHELD });
        expect(row.msg.list).toEqual([7, null]);
      }
    });

    it("numeric size fields survive, lifecycle rows are unchanged, and an unmarked thread keeps no text either (sink allowlist)", () => {
      appendNative("t-marked-sizes", { dir: "in", source: "codex", msg: { bytes: 1234, ok: false, text: "x" } });
      expect(rows("t-marked-sizes")[0].msg).toEqual({ bytes: 1234, ok: false });
      appendNative("t-marked-life", { dir: "lifecycle", source: "murage.engine-lifecycle", msg: { event: "mcp_ready_own", turnId: "fb296783-4baa-4128-831c-b46042fa7ced" } });
      expect(rows("t-marked-life")[0].msg).toEqual({ event: "mcp_ready_own", turnId: "fb296783-4baa-4128-831c-b46042fa7ced" });
      appendNative("t-open-thread", { dir: "in", source: "claude", msg: { type: "assistant", text: SECRET_WORDS } });
      expect(rows("t-open-thread")[0].msg).toEqual({ type: "assistant" });
    });

    it("the first phone call is withheld before any mark exists: a tool_use naming a phone tool, and its streamed argument fragments", () => {
      const thread = "t-first-call";
      appendNative(thread, { dir: "in", source: "claude", msg: { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__phoneJobs__phone_calendar_read", input: { start: "2026-10-26", note: "CANARY-ONE" } }] } } });
      appendNative(thread, { dir: "in", source: "claude", msg: { type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", name: "phone_location_get", input: {} } } } });
      appendNative(thread, { dir: "in", source: "claude", msg: { type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"precision\":\"CANARY-TWO\"}" } } } });
      appendNative(thread, { dir: "in", source: "claude", msg: { type: "stream_event", event: { type: "content_block_stop", index: 2 } } });
      appendNative(thread, { dir: "in", source: "codex", msg: { item: { type: "mcp_tool_call", server: "phoneJobs", tool: "phone_contacts_search", arguments: { query: "CANARY-THREE" } } } });
      appendNative(thread, { dir: "in", source: "claude", msg: { type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "ordinary text after the block closed" } } } });
      const log = readFileSync(join(NATIVE_DIR, `${thread}.ndjson`), "utf8");
      for (const canary of ["CANARY-ONE", "CANARY-TWO", "CANARY-THREE"]) expect(log).not.toContain(canary);
      // sink allowlist (was: toContain the ordinary text): text is never written; the frame after the block closed is still
      // written unwithheld, so withholding ended with the block
      expect(log).not.toContain("ordinary text after the block closed");
      expect(JSON.parse(log.trimEnd().split("\n").at(-1)!).msg).toEqual({ type: "stream_event", event: { type: "content_block_delta", index: 2 } });
    });
  });
});
