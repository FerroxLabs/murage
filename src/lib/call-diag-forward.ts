// Forwards the page's `[call-diag]` and `[call-trace]` console lines to the
// phone shell, which appends them to a file on the device (channel method
// diagLine), so a device call test leaves a readable record. Those lines
// carry counts and enums only (call-trace.ts); nothing else on the console
// ever crosses, and at most DIAG_MAX_PER_SECOND lines per second, each capped.

import { callNative, inNativeShell } from "./native-shell";

export const DIAG_MAX_CHARS = 500;
export const DIAG_MAX_PER_SECOND = 20;

const PREFIXES = ["[call-diag]", "[call-trace]"];

/** The one string to forward for these console arguments, or null. Only the
 * first argument counts, and only when it is a string starting with a prefix. */
export function diagLineFor(args: readonly unknown[]): string | null {
  const first = args[0];
  if (typeof first !== "string" || !PREFIXES.some((prefix) => first.startsWith(prefix))) return null;
  return first.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, DIAG_MAX_CHARS);
}

export function createDiagForwarder(
  send: (line: string) => void,
  now: () => number = Date.now,
): (args: readonly unknown[]) => void {
  let windowStart = 0;
  let used = 0;
  return (args) => {
    const line = diagLineFor(args);
    if (line === null) return;
    const t = now();
    if (t - windowStart >= 1000) {
      windowStart = t;
      used = 0;
    }
    if (used >= DIAG_MAX_PER_SECOND) return;
    used += 1;
    send(line);
  };
}

let installed = false;

export function resetCallDiagForwardForTest(): void {
  installed = false;
}

export function installCallDiagForward(inShell: boolean = inNativeShell()): void {
  if (!inShell || installed) return;
  installed = true;
  const forward = createDiagForwarder((line) => {
    // callNative waits for hello and rejects when this build lacks diagLine
    void callNative("diagLine", line).catch(() => {});
  });
  for (const level of ["warn", "log", "info"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        forward(args);
      } catch {
        // diagnostics only
      }
    };
  }
}
