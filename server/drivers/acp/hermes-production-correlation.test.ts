import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { HermesAgentDriver, hermesAcpSupport } from "./hermes.ts";
import { ensureDirs } from "../../config.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { resetVersionProbeBackoff } from "../isolation-cache.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const pinned = "Hermes Agent v0.22.2 (2026.9.24) · upstream d923a5eb";

it("unchanged production support accepts a pinned C1 read_file start", async () => {
  ensureDirs(); chmodSync(cli, 0o755); resetVersionProbeBackoff();
  const home = mkdtempSync(join(tmpdir(), "hermes-production-"));
  mkdirSync(join(home, "data"));
  const instance = await HermesAgentDriver.create({
    instanceId: "production", displayName: "Hermes", enabled: true,
    config: { cli, fullAuto: true },
    environment: {
      HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: join(home, "data"), HERMES_HOME: join(home, "hermes"),
      FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_VERSION: pinned, FAKE_ACP_AGENT_VERSION: "0.22.2",
      FAKE_ACP_SESSION_MODES: JSON.stringify({ currentModeId: "default" }),
      FAKE_ACP_SCRIPT: JSON.stringify([
        { at: 5, update: { sessionUpdate: "tool_call", toolCallId: "read", title: "read_file: seed.txt", kind: "read" } },
        { at: 10, update: { sessionUpdate: "tool_call_update", toolCallId: "read", kind: "read", status: "completed" } },
        { at: 20, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } },
        { at: 30, result: { stopReason: "end_turn" } },
      ]),
    },
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "production", text: "read seed.txt", cwd: home });
    const completed = await recorder.until(e => e.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true, stopReason: null });
  } finally { recorder.stop(); await instance.dispose(); removeTempDirSync(home); }
});

// The final decision belongs to the server's permission broker. Feed its ruled
// decisions through the unchanged production support and compare the exact ACP
// answer bytes: unavailable correlation evidence cannot second-guess the broker.
const levels = ["Ask", "Auto", "Full access", "No limits"] as const;
const contexts = ["owner-clean", "owner-tainted", "routine", "channel", "webhook", "delegated", "other-person"] as const;
const evidence = [
  { name: "missing", banner: pinned, version: "0.22.2", fail: true },
  { name: "bare-version", banner: "Hermes Agent v0.22.2 (2026.9.24)", version: "0.22.2" },
  { name: "wrong-pin", banner: "Hermes Agent v0.22.2 (2026.9.24) · upstream deadbeef", version: "0.22.2" },
  { name: "wrong-version", banner: pinned.replace("v0.22.2", "v0.22.3"), version: "0.22.3" },
  { name: "acp-mismatch", banner: pinned, version: "0.22.3" },
] as const;
const captures: unknown[] = [];
afterAll(() => {
  if (process.env.HERMES_PARITY_CAPTURE) writeFileSync(process.env.HERMES_PARITY_CAPTURE, JSON.stringify(captures, null, 2) + "\n");
});
for (const level of levels) for (const context of contexts) for (const install of evidence) {
  it(`production parity: ${level} / ${context} / ${install.name}`, async () => {
    ensureDirs(); chmodSync(cli, 0o755); resetVersionProbeBackoff();
    const home = mkdtempSync(join(tmpdir(), "hermes-parity-"));
    mkdirSync(join(home, "data"));
    const wire = join(home, "answers.jsonl");
    const decisions = ["allow", level === "No limits" && context === "owner-clean" ? "allow" : "deny", "deny"] as const;
    const steps = decisions.map((_, i) => ({
      ...(i ? { after: 70 + i } : {}), at: 5,
      request: { id: 71 + i, method: "session/request_permission", params: {
        toolCall: { toolCallId: `permission-${i}`, title: "terminal", kind: "execute", status: "pending",
          rawInput: { command: "<terminal> (plugin approval rule)", description: i === 1 ? "unreadable hook payload" : JSON.stringify({ murage: 1, v: 1, tool: "terminal", input: { command: i === 2 ? "denied action" : "echo safe" }, truncated: false }) } },
        options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }],
      } },
    }));
    const instance = await HermesAgentDriver.create({
      instanceId: "production", displayName: "Hermes", enabled: true, config: { cli, fullAuto: true },
      environment: { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: join(home, "data"), HERMES_HOME: join(home, "hermes"),
        FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_VERSION: install.banner, FAKE_ACP_AGENT_VERSION: install.version,
        FAKE_ACP_VERSION_FAIL: "fail" in install ? "1" : "0",
        // A mode the pinned FSM refuses must not refuse an unverified build.
        FAKE_ACP_SESSION_MODES: JSON.stringify({ currentModeId: "dont_ask" }),
        FAKE_ACP_SCRIPT_LOG: wire,
        FAKE_ACP_SCRIPT: JSON.stringify([...steps, { after: 73, at: 5, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } }, { after: 73, at: 10, result: { stopReason: "end_turn" } }]),
      },
    });
    const recorder = recordEvents(instance.adapter);
    const answers: Promise<unknown>[] = [];
    let opened = 0;
    const off = instance.adapter.onEvent(event => {
      if (event.type === "request.opened") answers.push(instance.adapter.respondToRequest("production", event.requestId!, { behavior: decisions[opened++]! }));
    });
    try {
      await instance.adapter.sendTurn({ threadId: "production", text: "parity", cwd: home,
        warmIdentity: { botId: "fixture", audience: context.startsWith("owner-") ? "owner" : "non-owner" },
        ...(level === "Ask" ? { routeAsks: true, askLevel: true } : level === "Auto" ? { routeAsks: true } : { stopLine: true }),
      });
      const completed = await recorder.until(e => e.type === "turn.completed");
      await Promise.all(answers);
      expect(completed).toMatchObject({ ok: true, stopReason: null });
      expect(opened).toBe(3);
      expect(recorder.events.filter(e => e.type === "runtime.error")).toEqual([]);
      const actual = readFileSync(wire, "utf8").trim().split("\n").map(line => JSON.stringify(JSON.parse(line).result));
      const expected = decisions.map(behavior => JSON.stringify({ outcome: { outcome: "selected", optionId: behavior === "allow" ? "yes" : "no" } }));
      expect(actual).toEqual(expected);
      captures.push({ level, context, evidence: install.name, answers: actual });
    } finally { off(); recorder.stop(); await instance.dispose(); removeTempDirSync(home); }
  });
}

it.each([
  [pinned, true],
  [pinned.replace("d923a5eb", "d923a5eb487a17c0a68801bba9ef0f56c81040a8"), true],
  [pinned + "\nInstall directory: /fixture", true],
  ["", false],
  ["0.22.2", false],
  [pinned.replace(" · upstream d923a5eb", ""), false],
  [pinned.replace("d923a5eb", "deadbeef"), false],
  [pinned.replace("v0.22.2", "v0.22.3"), false],
  [pinned.replace("v0.22.2", "v0.22.2-dev"), false],
  [pinned + " dirty", false],
])("production install evidence %s", (banner, verified) => {
  expect(Boolean(hermesAcpSupport.toolIdentityContext?.(banner).hermesInstallSha)).toBe(verified);
});
