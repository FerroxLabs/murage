import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINTS_DIR, restore } from "./checkpoints.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { errorTextCases, ERROR_TEXT_LEAK } from "./testing/error-text-fixtures.ts";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), execFile: vi.fn(),
}));
const scratch: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of scratch.splice(0)) removeTempDirSync(path); });
let sequence = 0;

describe("checkpoint errors delivered to the owner and server log", () => {
  for (const command of ["restore", "diff"]) {
    it.each(errorTextCases())(`redacts git ${command} stderr before its cut: $name`, async ({ raw, name }) => {
      const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "checkpoint-error-")));
      const bot = `error-text-${sequence++}`;
      const root = join(CHECKPOINTS_DIR, bot);
      scratch.push(cwd, root);
      const shadow = join(root, createHash("sha256").update(cwd).digest("hex").slice(0, 16), ".git");
      mkdirSync(shadow, { recursive: true });
      writeFileSync(join(shadow, "HEAD"), "fixture");
      const seen: string[] = [];
      vi.mocked(execFile).mockImplementation(((_file: string, args: string[], _options: unknown, callback: Function) => {
        seen.push(args[0]);
        if (args[0] === command) callback(Object.assign(new Error("git failed"), { code: 2 }), "", raw);
        else callback(null, args[0] === "rev-list" ? "b".repeat(40) : "a".repeat(40), "");
      }) as typeof execFile);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await restore(bot, cwd, "a".repeat(40));
      expect(seen).toContain(command);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected restore error");
      expect(result.error).not.toMatch(ERROR_TEXT_LEAK);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).not.toMatch(ERROR_TEXT_LEAK);
      if (name === "short diagnostic") expect(result.error).toBe(`restore failed: git ${command}: ${raw}`);
      else expect(result.error).toContain("redacted");
    });
  }
});
