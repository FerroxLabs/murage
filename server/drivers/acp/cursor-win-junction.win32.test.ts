// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Windows only: run as a STANDARD user (no admin, no Developer Mode). Makes the acp-sessions link exactly as a cursor
// turn does and asserts it does not fail with EPERM.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { linkCursorSessions, removeCursorSessionsLink, scopeCursorHostComputerConfig } from "./cursor.ts";

describe.skipIf(process.platform !== "win32")("cursor acp-sessions junction as a standard user", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-win-junction-"));
  afterAll(() => removeTempDirSync(root));

  it("creates a real junction with no EPERM and reads through it", () => {
    const target = join(root, "real", "acp-sessions");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "s1.json"), "ok");
    const link = join(root, "cfg", "acp-sessions");
    mkdirSync(join(root, "cfg"));
    expect(() => linkCursorSessions(target, link)).not.toThrow();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, "s1.json"), "utf8")).toBe("ok");
    expect(removeCursorSessionsLink(link)).toBe(true);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(target, "s1.json"), "utf8")).toBe("ok");
  });

  it("scopeCursorHostComputerConfig links the owner's sessions folder without EPERM", () => {
    const real = join(root, "owner-cursor");
    mkdirSync(real);
    const dir = scopeCursorHostComputerConfig({ CURSOR_CONFIG_DIR: real }, "bot-junction");
    expect(lstatSync(join(dir, "acp-sessions")).isSymbolicLink()).toBe(true);
  });
});
