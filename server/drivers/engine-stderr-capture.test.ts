// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every engine and VPS stderr capture has ONE shape (acp/core.ts EngineStderrCapture): the stream kept from its start,
// an unfinished PEM closed, the whole capture redacted, and only then the display cut. A tail window cut at its front
// lost a long key's `-----BEGIN` line (or a credential's label) before redaction, and the remaining body matched no rule.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactSecretsInText } from "../redact.ts";
import { EngineStderrCapture, engineStderrRedacted, engineStderrTailRedacted, ENGINE_STDERR_CAPTURE_CHARS } from "./acp/core.ts";
import { ERROR_MESSAGE_MAX } from "../../shared/provider-error.ts";

// Secret material made only of these three characters, so any surviving piece of it is visible.
const leaked = (text: string | undefined) => /Q7|7x|xQ/.test(text ?? "");
const BODY_LINE = "Q7x".repeat(21) + "Q"; // 64 characters, a base64 line's width
const pem = (label: string, chars: number) =>
  `-----BEGIN ${label}-----\n${`${BODY_LINE}\n`.repeat(Math.ceil(chars / 65))}-----END ${label}-----\n`;
const LABELS = ["PRIVATE KEY", "OPENSSH PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"];
// The tail windows the old captures kept: Codex 2048, pi and the VPS tunnel 4096, Antigravity and Claude 8192, VPS exec 64 KiB.
const OLD_WINDOWS = [2048, 4096, 8192, 65_536];
const DIAGNOSTIC = "fatal: engine stopped";

describe("a private key longer than every old tail window", () => {
  for (const window of OLD_WINDOWS) {
    for (const label of LABELS) {
      it(`${label} longer than ${window}: no body character survives, the diagnostic after it is quoted`, () => {
        const stderr = `starting\n${pem(label, window * 2)}${DIAGNOSTIC}\n`;
        // the old tail lost BEGIN: its body matched no rule (the case this fixes)
        expect(stderr.slice(-window)).not.toContain("-----BEGIN");
        expect(leaked(redactSecretsInText(stderr.slice(-window)))).toBe(true);
        const capture = new EngineStderrCapture();
        capture.push(stderr);
        expect(capture.truncated).toBe(false);
        const words = capture.lastWords();
        expect(leaked(words)).toBe(false);
        expect(words).toContain(DIAGNOSTIC);
        const end = capture.redactedEnd(1000);
        expect(leaked(end)).toBe(false);
        expect(end).toContain(DIAGNOSTIC);
      });

      it(`${label} cut by a ${window}-character capture (BEGIN kept, END lost): redacted to the end of the capture`, () => {
        const capture = new EngineStderrCapture(window);
        capture.push("starting\n");
        // pushed in small chunks, as a pipe delivers it
        const stderr = `${pem(label, window * 2)}${DIAGNOSTIC}\n`;
        for (let at = 0; at < stderr.length; at += 512) capture.push(stderr.slice(at, at + 512));
        expect(capture.truncated).toBe(true);
        expect(capture.text).toContain(`-----BEGIN ${label}-----`);
        expect(capture.text).not.toContain("-----END");
        expect(leaked(capture.lastWords())).toBe(false);
        expect(leaked(capture.redactedEnd(1000))).toBe(false);
        expect(capture.lastWords()).toContain("Stderr capture truncated; later output omitted");
      });
    }
  }

  it("the default capture is ACP's 256 KiB prefix and a key past it is still masked to the end", () => {
    const capture = new EngineStderrCapture();
    capture.push(pem("PRIVATE KEY", ENGINE_STDERR_CAPTURE_CHARS * 2));
    expect(capture.truncated).toBe(true);
    expect(capture.text.length).toBe(ENGINE_STDERR_CAPTURE_CHARS);
    expect(leaked(capture.lastWords())).toBe(false);
    expect(leaked(capture.redactedEnd(1000))).toBe(false);
  });
});

describe("a long credential value", () => {
  const credential = (chars: number) => `api_key=${"Q7x".repeat(Math.ceil(chars / 3))}`;

  it("a 300+ character api_key= value near the end leaves no secret character", () => {
    const stderr = `starting\nerror: request failed ${credential(330)}\n`;
    // the old order (cut, then redact) kept a bare piece of the value
    expect(leaked(redactSecretsInText(stderr.trim().slice(-300)))).toBe(true);
    const capture = new EngineStderrCapture();
    capture.push(stderr);
    expect(capture.lastWords()).toBeDefined();
    expect(leaked(capture.lastWords())).toBe(false);
    expect(leaked(capture.redactedEnd(1000))).toBe(false);
  });

  // Astra r7 Low: the fixture must put credential bytes INSIDE the display slice, so a cut taken before redaction
  // would show them. A value longer than the window, then a diagnostic shorter than the slice.
  for (const window of OLD_WINDOWS) {
    for (const [name, max] of [["exit line", ERROR_MESSAGE_MAX], ["1,000-character detail", 1000]] as const) {
      it(`a value longer than ${window} then a short diagnostic: the ${name} slice holds no credential byte`, () => {
        const stderr = `error: ${credential(window + 100)}\n${DIAGNOSTIC}\n`;
        // the old window started inside the value, past its label, and the shown slice reached back into it
        expect(stderr.slice(-window)).not.toContain("api_key=");
        expect(leaked(redactSecretsInText(stderr.slice(-window)).trim().slice(-max))).toBe(true);
        const capture = new EngineStderrCapture();
        capture.push(stderr);
        const shown = name === "exit line" ? capture.lastWords() : capture.redactedEnd(max);
        expect(shown).toContain(DIAGNOSTIC);
        expect(leaked(shown)).toBe(false);
      });
    }

    it(`a value cut by a ${window}-character capture: the cut line is dropped, nothing of it is shown`, () => {
      const capture = new EngineStderrCapture(window);
      capture.push(`${DIAGNOSTIC}\nerror: ${credential(window * 2)}\nlater\n`);
      expect(capture.truncated).toBe(true);
      expect(leaked(capture.lastWords())).toBe(false);
      expect(leaked(capture.redactedEnd(1000))).toBe(false);
      expect(capture.redactedEnd(1000)).toContain(DIAGNOSTIC);
    });
  }

  it("keeps the engine's own words when there is no secret, and says nothing for blank stderr", () => {
    const capture = new EngineStderrCapture();
    capture.push("pi could not load its settings\n");
    expect(capture.lastWords()).toBe("pi could not load its settings");
    expect(capture.redactedEnd(1000)).toBe("pi could not load its settings");
    const blank = new EngineStderrCapture();
    blank.push("  \n");
    expect(blank.lastWords()).toBeUndefined();
    expect(blank.redactedEnd(1000)).toBe("");
  });

  it("reset starts a fresh capture (Codex: stderr since the last protocol message)", () => {
    const capture = new EngineStderrCapture(16);
    capture.push("x".repeat(40));
    expect(capture.truncated).toBe(true);
    capture.reset();
    capture.push("fresh\n");
    expect(capture.truncated).toBe(false);
    expect(capture.lastWords()).toBe("fresh");
  });
});

describe("generated stderr credential/control matrix", () => {
  // Synthetic fixture text only. Each half exceeds the sk- rule's length
  // floor, so masking the first half alone cannot make this test pass.
  const value = "FAKE_CREDENTIAL_FOR_TEST_ONLY_".repeat(2);
  const middle = Math.floor(value.length / 2);
  // Every surviving fragment of length >= 6 contains one of these windows.
  const fragments = [...new Set(Array.from({ length: value.length - 5 }, (_, at) => value.slice(at, at + 6)))];
  const forms = [
    { label: "api_key", separator: "=" },
    { label: "token", separator: "=" },
    { label: "secret", separator: "=" },
    { label: "password", separator: ":" },
    { label: "sk", separator: "-" },
  ] as const;
  const controls = [
    ["ESC", "\u001b"],
    ["lone ESC plus reset", "\u001b\u001b[0m"],
    ["VT CSI", "\u001b[31m"],
    ["VT OSC", "\u001b]0;t\u0007"],
    ["ZWSP", "\u200b"],
    ["ZWJ", "\u200d"],
    ["BOM", "\ufeff"],
    ["tab", "\t"],
    ["NUL", "\u0000"],
  ] as const;
  const positions = [
    "before label after word",
    "before label after space",
    "between label and separator",
    "after separator",
    "inside value",
    "inside label (consistency only)",
  ] as const;
  const sinks = [
    ["prefix capture", (log: string) => engineStderrRedacted(log, false)],
    ["short log", (log: string) => engineStderrTailRedacted(log, false)],
    ["mid-file window", (log: string) => engineStderrTailRedacted(`partial\n${log}`, true)],
  ] as const;

  // 5 forms x 6 positions x 9 controls x 3 sinks = 810 cases.
  // The five requested positions require masking in all 675 combinations,
  // including controls that VT stripping would consume with a label letter.
  // An additional 135 split-label cases assert consistency only: a tab in
  // "to\tken" is two words, not a credential label. Other controls may rejoin
  // that spelling, but no split-label combination is omitted from the matrix.
  for (const { label, separator } of forms) {
    for (const position of positions) {
      for (const [controlName, control] of controls) {
        for (const [sinkName, redact] of sinks) {
          it(`${sinkName}: ${label}${separator}, ${position}, ${controlName}`, () => {
            const split = Math.floor(label.length / 2);
            const examples: Record<typeof positions[number], string> = {
              "before label after word": `bad${control}${label}${separator}${value}`,
              "before label after space": `bad ${control}${label}${separator}${value}`,
              "between label and separator": `${label}${control}${separator}${value}`,
              "after separator": `${label}${separator}${control}${value}`,
              "inside value": `${label}${separator}${value.slice(0, middle)}${control}${value.slice(middle)}`,
              "inside label (consistency only)": `${label.slice(0, split)}${control}${label.slice(split)}${separator}${value}`,
            };
            const log = `engine starting.\n\t${examples[position]}\r\nretry pending\n${DIAGNOSTIC}\n`;
            const shown = redact(log);
            expect(shown).toBe(engineStderrRedacted(log, false));
            expect(redact(shown)).toBe(shown);
            expect(redactSecretsInText(shown)).toBe(shown);
            expect(shown).toContain("engine starting.\n\t");
            expect(shown).toContain(`\r\nretry pending\n${DIAGNOSTIC}\n`);
            if (position !== "inside label (consistency only)") {
              expect(shown).toContain("redacted");
              for (const fragment of fragments) expect(shown).not.toContain(fragment);
            }
          });
        }
      }
    }
  }
});

describe("stderr controls after credential separators", () => {
  const sinks = [
    ["prefix capture", (log: string) => engineStderrRedacted(log, false)],
    ["short log", (log: string) => engineStderrTailRedacted(log, false)],
    ["mid-file window", (log: string) => engineStderrTailRedacted(`partial\n${log}`, true)],
  ] as const;

  for (const [name, redact] of sinks) {
    it.each(["api_key=", "token=", "secret=", "sk-"])(`${name}: %s followed by a lone escape and a reset sequence`, (prefix) => {
      const value = "FAKE_CREDENTIAL_FOR_TEST_ONLY";
      const log = `engine starting.\n\t${prefix}\u001b\u001b[0m${value}\r\nretry pending\n${DIAGNOSTIC}\n`;
      const shown = redact(log);
      expect(shown).not.toContain(value);
      expect(shown).not.toContain("\u001b");
      expect(shown).toContain("redacted");
      expect(shown).toMatch(/^engine starting\.\n\t[^\r\n]+\r\nretry pending\n/);
      expect(shown).toContain(`${DIAGNOSTIC}\n`);
      const tail = shown.trim().split(/\r?\n/).slice(-4);
      expect(tail).toHaveLength(4);
      expect(tail[0]).toBe("engine starting.");
      expect(tail[1]).toContain("redacted");
      expect(tail.slice(2)).toEqual(["retry pending", DIAGNOSTIC]);
    });
  }
});

describe("desktop log tails", () => {
  for (const startsMidFile of [false, true]) {
    it.each(["token=", "secret=", "sk-"])(`${startsMidFile ? "mid-file window" : "short log"}: %s behind a lone escape and a reset sequence`, (prefix) => {
      const value = "Q7x".repeat(14); // Synthetic marker, never a real credential.
      const log = `${startsMidFile ? "partial\n" : ""}\u001b\u001b[0m${prefix}${value}\n${DIAGNOSTIC}\n`;
      const shown = engineStderrTailRedacted(log, startsMidFile);
      expect(shown).not.toContain(value);
      expect(leaked(shown)).toBe(false);
      expect(shown).toContain("redacted");
      expect(shown).toContain(DIAGNOSTIC);
    });
  }

  it.each(LABELS)("masks a leading END-only %s block and keeps the current error", (label) => {
    const log = `${pem(label, ENGINE_STDERR_CAPTURE_CHARS * 2)}${DIAGNOSTIC}\n`;
    const window = Buffer.from(log).subarray(-ENGINE_STDERR_CAPTURE_CHARS).toString();
    expect(window).not.toContain("-----BEGIN");
    expect(window).toContain(`-----END ${label}-----`);
    const shown = engineStderrTailRedacted(window, true);
    expect(leaked(shown)).toBe(false);
    expect(shown).toContain("redacted");
    expect(shown).toContain(DIAGNOSTIC);
  });

  it("drops a partial first credential line, including a window with no newline", () => {
    expect(engineStderrTailRedacted(`${BODY_LINE}\n${DIAGNOSTIC}`, true)).toBe(DIAGNOSTIC);
    expect(engineStderrTailRedacted(BODY_LINE, true)).toBe("");
  });

  it("masks a tail wholly inside an unfinished PEM, with neither marker in view", () => {
    const window = `${BODY_LINE}\n`.repeat(5000).slice(-ENGINE_STDERR_CAPTURE_CHARS);
    const shown = engineStderrTailRedacted(window, true);
    expect(leaked(shown)).toBe(false);
    expect(shown).toContain("redacted");
  });

  it("retains a complete short log's first line and masks an unfinished PEM", () => {
    expect(engineStderrTailRedacted(DIAGNOSTIC, false)).toBe(DIAGNOSTIC);
    const shown = engineStderrTailRedacted(`partial\n${pem("PRIVATE KEY", 1024).split("-----END")[0]}`, true);
    expect(leaked(shown)).toBe(false);
    expect(shown).toContain("redacted");
  });
});

const tailWindow = /\bstderr\w*\s*=\s*(?:\([^;\n]*\)|[\w.]+)\s*\.slice\(\s*-\s*[\d_]+/i;

describe("every engine and VPS stderr capture uses the one shape", () => {
  const read = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
  it.each([
    "stderr = stderr.slice(-8192)",
    "stderr = (stderr + chunk).slice(-8_192)",
    "stderrDiagnostic = (x + chunk).slice(-4096)",
  ])("the guard catches a tail window: %s", (source) => {
    expect(source).toMatch(tailWindow);
  });

  it("pi, Antigravity, Codex, Claude and the VPS computer keep no tail window of stderr", () => {
    for (const file of ["pi.ts", "antigravity.ts", "codex.ts", "claude.ts", "../vps-computer.ts"]) {
      const src = read(file);
      expect(src, file).toContain("new EngineStderrCapture()");
      expect(src, file).not.toMatch(tailWindow);
      expect(src, file).not.toMatch(/acpEngineExitStderrText\([^)]*\.slice\(/);
      expect(src, file).not.toContain("stderr-tail");
    }
  });
});
