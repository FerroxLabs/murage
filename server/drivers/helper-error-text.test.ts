import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { errorTextCases, ERROR_TEXT_LEAK } from "../testing/error-text-fixtures.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { ClaudeDriver } from "./claude.ts";

describe("helper process errors delivered to callers", () => {
  for (const engine of ["claude", "antigravity"] as const) {
    for (const { source, exitCode } of [{ source: "stderr", exitCode: 0 }, { source: "stderr", exitCode: 1 }, { source: "result", exitCode: 0 }]) {
      it.each(errorTextCases())(`${engine}, ${source}, exit ${exitCode}, redacts before the 8192 character cut: $name`, async ({ raw, name }) => {
        ensureDirs();
        const root = mkdtempSync(join(tmpdir(), "helper-error-text-"));
        const cli = join(root, "fixture.mjs");
        writeFileSync(join(root, "stderr.txt"), raw);
        writeFileSync(cli, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("${engine === "claude" ? "2.1.295" : "1.1.22"}"); process.exit(0); }
if (process.argv.includes("auth")) { console.log('{"loggedIn":true}'); process.exit(0); }
process.stdin.resume();
await new Promise(resolve => process.stdin.on("end", resolve));
const text = readFileSync(new URL("stderr.txt", import.meta.url), "utf8");
if (${JSON.stringify(source)} === "result") {
  const frame = ${JSON.stringify(engine)} === "claude"
    ? { type: "result", is_error: true, result: text }
    : { event: "result", result: { status: "ERROR", message: text } };
  await new Promise(resolve => process.stdout.write(JSON.stringify(frame) + "\\n", resolve));
} else {
  for (let i = 0; i < text.length; i += 512) {
    await new Promise(resolve => process.stderr.write(text.slice(i, i + 512), resolve));
  }
}
process.exit(${exitCode});
`, { mode: 0o755 });
        let instance: ProviderInstance | undefined;
        try {
          const input = { instanceId: `error-${engine}`, displayName: undefined, environment: {}, enabled: true };
          instance = engine === "claude"
            ? await ClaudeDriver.create({ ...input, config: { cli, permissionMode: "acceptEdits" } })
            : await AntigravityDriver.create({ ...input, config: { cli, fullAuto: false } });
          expect(instance.generateText).toBeTypeOf("function");
          const error = await instance.generateText!("fixture prompt").catch((error: Error) => error);
          expect(error).toBeInstanceOf(Error);
          const message = (error as Error).message;
          expect(message).not.toMatch(ERROR_TEXT_LEAK);
          if (name === "short diagnostic") expect(message).toBe(raw);
          else expect(message).toContain("redacted");
        } finally {
          await instance?.dispose();
          await removeTempDir(root);
        }
      }, 30_000);
    }
  }
});
