// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { plainTurnError, turnErrorCode } from "./turn-error-code";

/** Every internal code the server can throw: `Error("CODE` in server sources. */
function serverCodes(): string[] {
  const codes = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "node_modules") walk(path); continue; }
      if (!/\.(ts|mts|mjs)$/.test(name) || /\.test\./.test(name)) continue;
      for (const match of readFileSync(path, "utf8").matchAll(/Error\("([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) codes.add(match[1]!);
    }
  };
  walk(fileURLToPath(new URL("../server", import.meta.url)));
  return [...codes];
}

it("finds the code a failed turn leads with, alone or before a colon, and nothing else", () => {
  expect(turnErrorCode("CLAUDE_SESSION_RESET_TIMEOUT")).toBe("CLAUDE_SESSION_RESET_TIMEOUT");
  expect(turnErrorCode("MEMORY_SESSION_RESET_UNAVAILABLE: this engine must end its retained session")).toBe("MEMORY_SESSION_RESET_UNAVAILABLE");
  expect(turnErrorCode("ECONNRESET")).toBeUndefined();
  expect(turnErrorCode("Claude exited 1 before result")).toBeUndefined();
  expect(turnErrorCode("API error (status 400): {}")).toBeUndefined();
});

it("every code the server throws reads as one plain sentence with a next step, never as the code", () => {
  const codes = serverCodes();
  expect(codes.length).toBeGreaterThan(100);
  expect(codes).toContain("MEMORY_REPLAY_LIMIT");
  for (const code of codes) {
    for (const bot of ["Sable", undefined]) {
      const line = plainTurnError(`${code}: developer detail`, bot)!;
      expect(line, code).toBeTruthy();
      expect(line).not.toContain(code);
      expect(line).not.toMatch(/[A-Z]{2,}_[A-Z]/);
      expect(line).toContain("Retry");
      expect(line).not.toMatch(/—|\bsafe|\bsafety\b|\bunsafe\b|Composio/i);
      expect(line.charAt(0)).toBe(line.charAt(0).toUpperCase());
    }
  }
});

it("the reset timeout names the bot and says what happens next", () => {
  expect(plainTurnError("CLAUDE_SESSION_RESET_TIMEOUT", "Sable")).toBe("Sable's engine was starting a fresh conversation and needed a moment longer. Select Retry to send your message again.");
  expect(plainTurnError("MEMORY_REPLAY_LIMIT")).toMatch(/^The bot had more history/);
});
