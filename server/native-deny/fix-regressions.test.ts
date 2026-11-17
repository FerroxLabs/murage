import { removeTempDirSync } from "../testing/cleanup.ts";
// Fakes only: payloads are read as data, never executed.
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileDenySpec, testTools } from "./test-support.ts";
import { canonicalJson, pathAliases, sha256 } from "./compile.ts";
import { createNativeDenySession, decideNoLimitsNative, makeNativeDenyRequest, verifyNativeDenyIntegrity } from "./backstop.ts";
import { GATE_MESSAGE_BYTES, readNativeCode, readNativeShell } from "./upstream.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "native-deny-fix-")); dirs.push(dir); return dir; };
function fixture(extra = {}) {
  return createNativeDenySession({ turnId: "fix", engine: "codex", generation: 1, tools: testTools,
    onTamper: () => {}, log: () => {}, policyHash: sha256("policy"), envSha256: sha256("env"),
    spec: compileDenySpec(), cwd: "/tmp", home: "/home/alice", shell: { path: "/bin/bash", mode: "command" }, ...extra });
}
const decide = (s: ReturnType<typeof fixture>, name: string, args: unknown) => decideNoLimitsNative(s, makeNativeDenyRequest(s, name, args));

describe("F1 direct code identity", () => {
  it.each([
    ["import shutil; shutil.rmtree('/')", "delete-root"],
    ["import shutil; shutil.rmtree('/etc')", "delete-system-folder"],
    ["import os; os.system('rm -rf /')", "delete-root"],
  ])("denies raw Python %s", async (code, reason) => {
    expect(await decide(fixture(), "execute_code", { code, language: "python" })).toMatchObject({ allow: false, reason });
    expect(readNativeCode(code)).toMatchObject({ verdict: "card", cls: reason });
  });
  it.each(["print(1)", "import shutil; shutil.rmtree('/tmp/ordinary-build')", "print(\"shutil.rmtree('/')\")"])("allows benign Python %s", async code => {
    for (const args of [{ code }, { code, language: "python" }]) expect((await decide(fixture(), "execute_code", args)).allow).toBe(true);
  });
  it("rejects conflicting or unknown language declarations", async () => {
    for (const language of ["javascript", "node", "sh", "unknown", "", null, 1, {}]) {
      expect(await decide(fixture(), "execute_code", { code: "print(1)", language })).toMatchObject({ allow: false, reason: "code-language" });
    }
  });
});

describe("F2 reader exhaustion", () => {
  it.each([false, true])("denies over-reader-budget code below transport cap (wipe=%s)", async wipe => {
    const args = { code: "#" + "x".repeat(1_000_001) + (wipe ? "\nimport shutil; shutil.rmtree('/')" : "\nprint(1)") };
    const s = fixture(), request = makeNativeDenyRequest(s, "execute_code", args);
    expect(Buffer.byteLength(canonicalJson(request))).toBeLessThan(GATE_MESSAGE_BYTES);
    expect(await decideNoLimitsNative(s, request)).toMatchObject({ allow: false, reason: "truncated" });
  });
  it("denies work exhaustion below both text and transport limits", async () => {
    const code = "x=0\n".repeat(140_000);
    expect(code.length).toBeLessThan(1_000_000);
    expect(await decide(fixture(), "execute_code", { code })).toMatchObject({ allow: false, reason: "truncated" });
  });
  it.each([false, true])("denies over-reader-budget shell below transport cap (wipe=%s)", async wipe => {
    const s = fixture(), request = makeNativeDenyRequest(s, "exec_command", { cmd: "#" + "x".repeat(1_000_001) + (wipe ? "\nrm -rf /" : "\necho ok") });
    expect(Buffer.byteLength(canonicalJson(request))).toBeLessThan(GATE_MESSAGE_BYTES);
    expect(await decideNoLimitsNative(s, request)).toMatchObject({ allow: false, reason: "truncated" });
  });
  it("does not let the word proxy hide a nested reader cut", async () => {
    const cmd = "rm -rf build; python -c '" + "x=0;".repeat(140_000) + "'";
    expect(cmd.length).toBeLessThan(1_000_000);
    expect(readNativeShell(cmd)).toMatchObject({ cls: "plainWipe", incomplete: true });
    expect(await decide(fixture(), "exec_command", { cmd })).toMatchObject({ allow: false, reason: "truncated" });
  });
  it("retains ordinary short shell and plain wipe controls", async () => {
    for (const cmd of ["echo ok", "rm -rf /tmp/ordinary-build"]) expect((await decide(fixture(), "exec_command", { cmd })).allow).toBe(true);
  });
});

describe("F3 symlink before dot-dot", () => {
  it.each([false, true])("places aliases component-wise, including missing leaves and relative names (relative link=%s)", async relative => {
    // Isolated equivalent of /tmp/alias -> /tmp/refused/sub; never touch shared /tmp names.
    const dir = temp(), refused = join(dir, "refused"), alias = join(dir, "alias");
    mkdirSync(join(refused, "sub"), { recursive: true });
    writeFileSync(join(refused, "x"), "canary");
    symlinkSync(relative ? "refused/sub" : join(refused, "sub"), alias);
    const s = fixture({ cwd: dir, spec: compileDenySpec({ refusals: [{ kind: "path", value: refused, reason: "owner" }] }) });
    for (const leaf of ["x", "missing"]) {
      const raw = `${alias}/../${leaf}`;
      expect(pathAliases(raw)).toContain(`${refused}/${leaf}`);
      for (const cmd of [`cat ${raw}`, `cat alias/../${leaf}`]) expect(await decide(s, "exec_command", { cmd })).toMatchObject({ allow: false, reason: "refused-path" });
    }
    expect((await decide(s, "exec_command", { cmd: `cat ${dir}/x` })).allow).toBe(true);
    expect(readFileSync(join(refused, "x"), "utf8")).toBe("canary");
  });
  it("denies symlink loops instead of treating an unresolved target as safe", async () => {
    const dir = temp(); symlinkSync("b", join(dir, "a")); symlinkSync("a", join(dir, "b"));
    expect(() => pathAliases(`${dir}/a/x`)).toThrow();
    expect(await decide(fixture({ cwd: dir }), "exec_command", { cmd: "cat a/x" })).toMatchObject({ allow: false, reason: "backstop-failure" });
  });
});

describe("F4 binding amendment 4 transient tampering", () => {
  function pin() {
    const path = join(temp(), "config"); writeFileSync(path, "original");
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    const before = statSync(path), onTamper = vi.fn(), s = fixture({ integrityFiles: [path], onTamper });
    const edit = (bytes: string) => { writeFileSync(path, bytes); utimesSync(path, before.atime, before.mtime); };
    return { path, s, edit, onTamper, before };
  }
  it("pins the edit-use-restore gap between checks without claiming containment", async () => {
    const { path, s, edit, onTamper, before } = pin();
    expect(await decide(s, "exec_command", { cmd: "echo ok" })).toMatchObject({ allow: true });
    edit("changed!");
    // Fake use point witnesses different bytes; no edited config or payload is executed.
    const usedBytes = readFileSync(path, "utf8");
    expect(usedBytes).toBe("changed!");
    expect(sha256(usedBytes)).not.toBe(s.pins[0].hash);
    edit("original");
    expect(statSync(path).ino).toBe(before.ino);
    expect(statSync(path).size).toBe(before.size);
    expect(statSync(path).mtimeMs).toBeCloseTo(before.mtimeMs, 2);
    expect(verifyNativeDenyIntegrity(s)).toBe(true); // Turn-end sampling cannot detect the earlier use.
    expect(await decide(s, "exec_command", { cmd: "echo ok" })).toMatchObject({ allow: true });
    expect(onTamper).not.toHaveBeenCalled();
    expect(s.retired).toBe(false);
  });
  it("denies at the request use point before a later restore", async () => {
    const { s, edit, onTamper } = pin();
    edit("changed!");
    const read = vi.fn(() => { edit("original"); return null; });
    expect(await decideNoLimitsNative(s, makeNativeDenyRequest(s, "exec_command", { cmd: "echo ok" }), { read })).toMatchObject({ allow: false, reason: "retired-or-tamper" });
    expect(read).not.toHaveBeenCalled();
    edit("original");
    expect(await decide(s, "exec_command", { cmd: "echo ok" })).toMatchObject({ allow: false });
    expect(onTamper).toHaveBeenCalledOnce();
    expect(s.conversationProfile).toBe("today"); expect(s.generation).toBe(2);
  });
  it("rechecks canonical bytes at the pending allow use point", async () => {
    const { s, edit, onTamper } = pin();
    let finish!: (value: null) => void;
    const pending = decideNoLimitsNative(s, makeNativeDenyRequest(s, "exec_command", { cmd: "echo ok" }), {
      read: () => new Promise(resolve => { finish = resolve; }),
    });
    edit("changed!"); finish(null);
    expect(await pending).toMatchObject({ allow: false, reason: "retired-or-tamper" });
    edit("original");
    expect(await decide(s, "exec_command", { cmd: "echo ok" })).toMatchObject({ allow: false });
    expect(onTamper).toHaveBeenCalledOnce();
    expect(s.retired).toBe(true);
  });
});
