// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { describeTurnError, plainTurnError, turnErrorCode } from "./turn-error-code";

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
      expect(line).not.toMatch(/—|\bsafe|\bsafety\b|\bunsafe\b|Composio/i);
      expect(line.charAt(0)).toBe(line.charAt(0).toUpperCase());
    }
  }
});

it("the reset timeout names the bot and says what happens next", () => {
  expect(plainTurnError("CLAUDE_SESSION_RESET_TIMEOUT", "Sable")).toBe("Sable's engine was starting a fresh conversation and needed a moment longer. Select Retry to send your message again.");
  expect(plainTurnError("MEMORY_REPLAY_LIMIT")).toMatch(/^The bot had more history/);
});

it("every code carries a recovery class, and only a retry-class sentence names the Retry button", () => {
  for (const code of serverCodes()) {
    const withButton = describeTurnError(`${code}: detail`, "Sable", { canRetry: true })!;
    const without = describeTurnError(`${code}: detail`, "Sable", { canRetry: false })!;
    expect(withButton.recovery, code).toBe(without.recovery);
    // no button on the card, no sentence that points at it
    expect(without.text, code).not.toContain("Retry");
    if (withButton.recovery === "retry") expect(withButton.text, code).toContain("Retry");
    // a sentence that is not about sending again never points at the button
    if (withButton.recovery === "contact" || withButton.recovery === "blocked" || withButton.recovery === "change-setting" && code === "MEMORY_SESSION_RESET_UNAVAILABLE") expect(withButton.text, code).not.toContain("Retry");
    if (withButton.recovery === "blocked") expect(withButton.text, code).not.toMatch(/again|try/i);
  }
});

it("keeps the setup action each configuration problem needs", () => {
  const link = describeTurnError("HUMAN_LINK_REQUIRED: link this verified channel account", "Sable")!;
  expect(link.recovery).toBe("link-account");
  expect(link.text).toMatch(/Settings/);
  expect(link.text).toMatch(/link the channel account/);
  const collision = describeTurnError("MEMORY_MCP_NAME_COLLISION", "Sable")!;
  expect(collision.recovery).toBe("change-setting");
  expect(collision.text).toMatch(/Rename that custom tool/);
  const unavailable = describeTurnError("MEMORY_SESSION_RESET_UNAVAILABLE: this engine must end its retained session", "Sable")!;
  expect(unavailable.recovery).toBe("change-setting");
  expect(unavailable.text).not.toMatch(/moment longer|Retry/);
  expect(unavailable.text).toMatch(/different engine/);
  const agents = describeTurnError("MURAGE_AGENTS_UNAVAILABLE: the Murage control connection failed", "Sable")!;
  expect(agents.recovery).toBe("contact");
  expect(agents.text).toMatch(/assigned twice/);
  expect(agents.text).not.toContain("Retry");
});

it("a request the provider blocked gets no retry advice", () => {
  for (const code of ["SAFETY_CHECK_FAILED", "SAFETY_POLICY_VIOLATION"]) {
    const line = describeTurnError(code, "Sable", { canRetry: true })!;
    expect(line.recovery).toBe("blocked");
    expect(line.text).not.toContain("Retry");
  }
});

it("without a Retry button the transient sentences say to send the message again", () => {
  expect(plainTurnError("CLAUDE_SESSION_RESET_TIMEOUT", "Sable", { canRetry: false })).toBe("Sable's engine was starting a fresh conversation and needed a moment longer. Send your message again.");
});
