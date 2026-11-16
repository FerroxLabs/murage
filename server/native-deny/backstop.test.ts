import { removeTempDirSync } from "../testing/cleanup.ts";
import { mkdtempSync, writeFileSync, symlinkSync, statSync, utimesSync } from "node:fs";
import { compileDenySpec, testTools } from "./test-support.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256, canonicalJson } from "./compile.ts";
import { createNativeDenySession, decideNoLimitsNative, makeNativeDenyRequest, verifyNativeDenyIntegrity, NATIVE_DENY_DEADLINE_MS } from "./backstop.ts";
import { GATE_MESSAGE_BYTES } from "./upstream.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) removeTempDirSync(d); });
export function fixture(extra = {}) {
  return createNativeDenySession({ turnId: "turn", engine: "codex", onTamper: () => {}, log: () => {}, tools: testTools, generation: 1, policyHash: sha256("policy"), spec: compileDenySpec({ refusals: [{ kind: "path", value: "/tmp/refused", reason: "owner" }, { kind: "tool", value: "web_search", reason: "off" }], selfPaths: ["/tmp/native-config"] }), cwd: "/tmp", home: "/home/alice", shell: { path: "/bin/bash", mode: "command" }, envSha256: sha256("env"), ...extra });
}
const call = (s: ReturnType<typeof fixture>, name: string, args: unknown) => makeNativeDenyRequest(s, name, args);

describe("T-BS-1 reader parity", () => {
  it.each(["rm -rf /", "rm -rf ~", "sh -c 'rm -rf /'", "bash -lc 'rm -rf ~'", 'python -c "import shutil; shutil.rmtree(\'/\')"', 'node -e "require(\'fs\').rmSync(\'/\', {recursive:true})"', "dd if=/tmp/x of=/dev/sda", ":(){ :|:& };:"])("denies %s without executing it", async command => {
    const s = fixture(); expect((await decideNoLimitsNative(s, call(s, "exec_command", { cmd: command }))).allow).toBe(false);
  });
  it.each(["echo hello", "touch /tmp/ok", "printf x > /dev/null", "touch /private/tmp/x", "touch /var/folders/x", "a-program-the-reader-does-not-model --x"])("allows ordinary or unreadable text: %s", async command => {
    const s = fixture(); expect((await decideNoLimitsNative(s, call(s, "exec_command", { cmd: command }))).allow).toBe(true);
  });
  it("M12 ignores outside marks and retains refusals and protected writes", async () => {
    const s = fixture();
    expect((await decideNoLimitsNative(s, { ...call(s, "exec_command", { cmd: "echo hi" }), outside: true })).allow).toBe(true);
    for (const [name, args] of [["write_file", { path: "/etc/x" }], ["read_file", { path: "/tmp/refused/x" }], ["search", { path: "/tmp/refused" }], ["web_search", { query: "x" }], ["exec_command", { cmd: "cat /tmp/refused/x" }]] as const) expect((await decideNoLimitsNative(s, call(s, name, args))).allow).toBe(false);
    expect((await decideNoLimitsNative(s, call(s, "write_file", { path: "/home/alice/ok" }))).allow).toBe(true);
  });
  it("M25 nonempty stdin is denied, empty polling is allowed", async () => {
    const s = fixture();
    expect((await decideNoLimitsNative(s, call(s, "write_stdin", { session_id: 1, chars: "rm -rf ~\n" }))).allow).toBe(false);
    for (const chars of ["rm -", "rf ~\n", "import shutil\n", "shutil.rmtree('/')\n", "cd /etc\n", "cat <<EOF\n", "body\nEOF\n"]) expect((await decideNoLimitsNative(s, call(s, "write_stdin", { session_id: 1, chars }))).allow).toBe(false);
    expect((await decideNoLimitsNative(s, call(s, "write_stdin", { session_id: 1, chars: "" }))).allow).toBe(true);
  });
  it("logs bounded verdict metadata without command text or tokens", async () => {
    const log = vi.fn(); const s = fixture({ log });
    await decideNoLimitsNative(s, call(s, "exec_command", { cmd: "echo private-payload" }));
    expect(log).toHaveBeenCalledOnce(); const line = log.mock.calls[0][0];
    expect(line).toMatch(/^native-deny engine=codex class=shell verdict=allow rule=- ms=\d+$/);
    expect(line).not.toContain("private-payload"); expect(line).not.toContain(s.token);
  });
  it("keeps mandatory and typed findings ahead of the wipe-table run labels", async () => {
    const s = fixture();
    for (const hit of [{ rule: "unknown-target" as const, classification: "deny" as const, what: "found" }, { rule: "unreadable" as const, mandatory: true as const, what: "found" }, { rule: "unreadable" as const, namedCatastrophe: true as const, what: "found" }]) expect((await decideNoLimitsNative(s, call(s, "exec_command", { cmd: "echo ok" }), { read: () => hit })).allow).toBe(false);
  });
  it("denies wrapped shell commands with typed findings ahead of generic code classes", async () => {
    const s = fixture();
    const request = call(s, "exec_command", { cmd: "sh -c 'rm -rf /'" });
    expect(await decideNoLimitsNative(s, request, { read: () => ({ rule: "unknown-target", classification: "deny", what: "typed finding" }) })).toMatchObject({ allow: false, reason: "unknown-target" });
  });
  it("retires pending authorizations across a generation change", async () => {
    const s = fixture(); let finish!: (value: null) => void;
    const pending = decideNoLimitsNative(s, call(s, "exec_command", { cmd: "echo ok" }), { read: () => new Promise(resolve => { finish = resolve; }) });
    s.generation++; finish(null); expect((await pending).allow).toBe(false);
  });
  it("fails closed on reader throw and timeout, with native deadline", async () => {
    expect(NATIVE_DENY_DEADLINE_MS).toBe(10_000);
    const s = fixture();
    expect((await decideNoLimitsNative(s, call(s, "exec_command", { cmd: "echo ok" }), { read: () => { throw Error("reader"); } })).allow).toBe(false);
    vi.useFakeTimers();
    try {
      const pending = decideNoLimitsNative(s, call(s, "exec_command", { cmd: "echo ok" }), { read: () => new Promise(() => {}) });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).allow).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe("T-BS-2 operation binding", () => {
  it("rejects missing fields, digest mismatch, replay, stale generation and forged context", async () => {
    const s = fixture(); const good = call(s, "exec_command", { cmd: "echo ok" });
    for (const field of ["v", "token", "generation", "callId", "engine", "tool", "args", "argsSha256", "policyHash", "denySpecHash", "shell", "cwd", "envSha256"]) { const bad = { ...good }; delete (bad as Record<string, unknown>)[field]; expect((await decideNoLimitsNative(s, bad)).allow, field).toBe(false); }
    for (const patch of [{ engine: "claude" }, { generation: 0 }, { policyHash: "other" }, { denySpecHash: "other" }, { argsSha256: "wrong" }, { token: "wrong" }, { cwd: "/etc" }, { shell: { path: "/bin/sh", mode: "command" } }, { envSha256: "wrong" }, { tool: { name: "unknown" } }, { args: { cmd: "echo ok", truncated: true } }]) expect((await decideNoLimitsNative(s, { ...call(s, "exec_command", { cmd: "echo ok" }), ...patch })).allow).toBe(false);
    expect((await decideNoLimitsNative(s, good)).allow).toBe(true);
    expect((await decideNoLimitsNative(s, good)).allow).toBe(false);
  });
  it("rejects incomplete arguments even with a matching digest, and oversize input", async () => {
    const s = fixture();
    for (const args of [{}, { cmd: 3 }, { cmd: "echo ok", truncated: true }, { cmd: "echo ok", inputMissing: "cmd" }, { cmd: "echo ok", cwd: "/etc" }, { cmd: "echo ok", env: {} }, { cmd: "echo ok", command: "rm -rf /" }, { cmd: "echo ok", shell: "/bin/sh" }]) { const req = call(s, "exec_command", args); expect(req.argsSha256).toBe(sha256(canonicalJson(args))); expect((await decideNoLimitsNative(s, req)).allow).toBe(false); }
    expect((await decideNoLimitsNative(s, call(s, "exec_command", { cmd: "x".repeat(GATE_MESSAGE_BYTES) }))).allow).toBe(false);
    expect((await decideNoLimitsNative(s, call(s, "apply_patch", { patch: "incomplete" }))).allow).toBe(false);
    expect((await decideNoLimitsNative(s, call(s, "mcp__other__write", {}))).allow).toBe(false);
  });
});

describe("T-BS-3 self-protection", () => {
  it("denies text naming self files and aliases into a refused folder", async () => {
    const d = mkdtempSync(join(tmpdir(), "native-deny-test-")); dirs.push(d);
    symlinkSync("/tmp/refused", join(d, "alias")); const s = fixture();
    for (const cmd of ["echo x > /tmp/native-config", "cat /tmp/native-config", "cat /tmp/../tmp/native-config", "cat native-config", "cat ./native-config"]) expect((await decideNoLimitsNative(s, call(s, "exec_command", { cmd }))).allow).toBe(false);
    expect((await decideNoLimitsNative(s, call(s, "read_file", { path: join(d, "alias", "x") }))).allow).toBe(false);
  });
  it("detects same-size edits with restored mtime, and checks pins at turn end", () => {
    const d = mkdtempSync(join(tmpdir(), "native-deny-metadata-")); dirs.push(d); const p = join(d, "config"); writeFileSync(p, "original");
    const s = fixture({ integrityFiles: [p] }); const before = statSync(p); writeFileSync(p, "changed!"); utimesSync(p, before.atime, before.mtime);
    expect(verifyNativeDenyIntegrity(s)).toBe(false);
  });
  it("retires the session, bumps generation and calls the tamper handler when a pin changes", async () => {
    const d = mkdtempSync(join(tmpdir(), "native-deny-pin-")); dirs.push(d); const p = join(d, "config"); writeFileSync(p, "original");
    const onTamper = vi.fn(); const s = fixture({ integrityFiles: [p], onTamper });
    const req = call(s, "exec_command", { cmd: "echo ok" }); writeFileSync(p, "tampered");
    expect((await decideNoLimitsNative(s, req)).allow).toBe(false);
    expect(s.generation).toBe(2); expect(s.retired).toBe(true); expect(s.conversationProfile).toBe("today"); expect(onTamper).toHaveBeenCalledOnce();
    expect((await decideNoLimitsNative(s, call(s, "exec_command", { cmd: "echo ok" }))).allow).toBe(false);
  });
});
