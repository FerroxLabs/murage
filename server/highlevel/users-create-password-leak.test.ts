import { expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { gzipSync } from "node:zlib";
import { removeTempDir } from "../testing/cleanup.ts";
import { passwordEchoGuard, generatePrivateUserPassword } from "./users-create-password.ts";
import { UserCreateIdentityClaims } from "./users-create-identity.ts";
import { existsSync } from "node:fs";
const path = "../testing/highlevel-leak-guard-v2.ts";
const mod = existsSync(new URL(path, import.meta.url)) ? await import(path) : {};
const required = (): any => { expect(typeof mod.HighLevelLeakGuardV2).toBe("function"); return mod; };
it("R10 v2 positive controls detect binary/literal/escaped/URL/base64/UTF-16 and decoded gzip without printing secrets", async () => {
  const m = required(), secret = `FixtureA4!${randomBytes(24).toString("hex")}`;
  const guard = new m.HighLevelLeakGuardV2([secret]);
  const forms = [Buffer.from(secret), Buffer.from(JSON.stringify(secret).slice(1, -1)), Buffer.from(encodeURIComponent(secret)), Buffer.from(Buffer.from(secret).toString("base64")), Buffer.from(secret, "utf16le"), Buffer.from(secret, "utf16le").swap16(), Buffer.from([...secret].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""))];
  const directory = mkdtempSync(join(tmpdir(), "hlpw-leak-"));
  try {
    for (let index = 0; index < forms.length; index++) {
      const file = join(directory, `positive-${index}.bin`);
      writeFileSync(file, Buffer.concat([Buffer.from([0, 255, 0]), forms[index]!, Buffer.from([0])]));
      const result = await guard.scanFiles([file]);
      expect(result.leaks > 0).toBe(true); expect(JSON.stringify(result).includes(secret)).toBe(false);
    }
    writeFileSync(join(directory, "positive.gz"), gzipSync(Buffer.from(secret)));
    expect((await guard.scanFiles([join(directory, "positive.gz")])).leaks > 0).toBe(true);
    const zip = new ZipFile();
    const archived = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; zip.outputStream.on("data", chunk => chunks.push(chunk));
      zip.outputStream.on("end", () => resolve(Buffer.concat(chunks))); zip.outputStream.on("error", reject);
    });
    zip.addBuffer(Buffer.from(secret), "positive.txt"); zip.end();
    writeFileSync(join(directory, "positive.zip"), await archived);
    const zipped = await guard.scanFiles([join(directory, "positive.zip")]);
    expect(zipped.decoded > 0 && zipped.leaks > 0).toBe(true);
    writeFileSync(join(directory, "unreadable"), "nonsecret", { mode: 0o000 });
    await expect(guard.scanFiles([join(directory, "unreadable")])).rejects.toThrow("Leak evidence is incomplete.");
    await expect(guard.scanFiles([join(directory, "missing")])).rejects.toThrow("Leak evidence is incomplete.");
    mkdirSync(join(directory, "empty"));
    await expect(guard.scanFiles([join(directory, "empty")])).rejects.toThrow("Leak evidence is incomplete.");
  } finally { removeTempDir(directory); }
});
it("R10 v2 intercepts every named outbound sink before persistence, including replaced and rejected input", () => {
  const m = required(), secrets = Array.from({ length: 4 }, () => `FixtureA4!${randomBytes(24).toString("hex")}`);
  const guard = new m.HighLevelLeakGuardV2(secrets);
  let reached = 0;
  for (const sink of ["telemetry", "model_context", "tool_context", "event_stream", "ipc_diagnostics", "logging"]) {
    const send = guard.wrapSink(sink, () => reached++);
    send({ code: "user_added", id: "fixture1" });
    for (const secret of secrets) {
      let rejected = false;
      try { send({ allowed: { name: Buffer.from(secret).toString("base64") } }); } catch { rejected = true; }
      expect(rejected).toBe(true);
    }
  }
  expect(reached).toBe(6);
  expect(guard.sinkCounts()).toEqual({ telemetry: 4, model_context: 4, tool_context: 4, event_stream: 4, ipc_diagnostics: 4, logging: 4 });
});

it("R10 scans the primitive fixture's SQLite/WAL, journals, logs and archives before close and after restart", async () => {
  const m = required(), directory = mkdtempSync(join(tmpdir(), "hlpw-persistence-"));
  const secrets = [generatePrivateUserPassword().toString('ascii'), `CustomA4!${randomBytes(24).toString("hex")}`, generatePrivateUserPassword().toString('ascii')];
  const guard = new m.HighLevelLeakGuardV2(secrets);
  const file = join(directory, "claims.sqlite"); let store = new UserCreateIdentityClaims(file);
  const lines: string[] = [];
  try {
    for (const [index, secret] of secrets.entries()) {
      const binding = { actionId: `fixture-${index}`, reviewDigest: "d".repeat(64), desktopSession: "fixture-desktop", turnGeneration: "turn", expiresAt: Date.now() + 10000 };
      const claim = store.acquire("co_fixture", `fixture${index}@example.test`, binding.actionId)!;
      claim.barrier();
      const echo = passwordEchoGuard(secret);
      const result = { user: { id: `user${index}` } };
      try { expect(echo.safe(result)).toBe(true); expect(echo.safe({ echoed: secret })).toBe(false); }
      finally { echo.dispose(); }
      for (const sink of ["telemetry", "model_context", "tool_context", "event_stream", "ipc_diagnostics", "logging"])
        guard.wrapSink(sink, (value: unknown) => lines.push(JSON.stringify(value)))(result);
    }
    writeFileSync(join(directory, "journals.jsonl"), lines.join("\n"));
    writeFileSync(join(directory, "diagnostics.log"), "fixed fixture diagnostic only\n");
    writeFileSync(join(directory, "archive.gz"), gzipSync(Buffer.from(lines.join("\n"))));
    expect((await guard.scanFiles([directory])).leaks).toBe(0);
    store.close();
    expect((await guard.scanFiles([directory])).leaks).toBe(0);
    store = new UserCreateIdentityClaims(file);
    expect(store.status("co_fixture", "fixture0@example.test")).toBe("outcome_unknown");
    expect((await guard.scanFiles([directory])).leaks).toBe(0);
  } finally { store.close(); secrets.fill(""); removeTempDir(directory); }
});
