// SPDX-License-Identifier: AGPL-3.0-or-later
// The home's collect_logs allowlist carries the UI canary's fixed-words tick line, on both sides of the shared contract.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOG_EVENTS, allowedLogMessage, scrubLogMessage } from "../../cloudflare/control-plane/src/self-service.ts";

const contract = JSON.parse(readFileSync(new URL("../../shared/self-service-contract.json", import.meta.url), "utf8")) as { logEvents: string[] };
const canary = contract.logEvents.filter(p => p.startsWith("\\[ui-canary\\]"));
describe("ui-canary log line in the collect_logs allowlist", () => {
  it("is one anchored pattern, identical in the contract, the runner and the control plane", () => {
    expect(canary).toHaveLength(1);
    expect(LOG_EVENTS).toContain(canary[0]);
    expect(readFileSync(new URL("../../deploy/cloud-home/murage-commands", import.meta.url), "utf8")).toContain(`r"${canary[0]}"`);
  });
  it("keeps every line form the canary writes and nothing free-text", () => {
    const re = new RegExp(`^(?:${canary[0]})$`);
    for (const ok of ["[ui-canary] launch gen=1 result=failed error=open-launcher-refused", "[ui-canary] launch gen=4 result=ok",
      "[ui-canary] instance-write-failed", "[ui-canary] stale-instance launch gen=2 result=failed error=timed-out teardown-unconfirmed cleanup-busy-exit-75"]) {
      expect(re.test(ok)).toBe(true); expect(allowedLogMessage(ok)).toBe(ok);
    }
    for (const bad of ["[ui-canary] launch gen=1 result=failed error=Open Refused", "[ui-canary] launch gen=1 result=failed error=a/b", "[ui-canary] hello",
      "[ui-canary] launch gen=-1 result=ok", "x [ui-canary] launch gen=1 result=ok", "[ui-canary] launch gen=1 result=ok\\nsecret", "[ui-canary]"]) {
      expect(re.test(bad)).toBe(false); expect(allowedLogMessage(bad)).toBe("[1 line omitted]");
    }
  });
});

// The error codes are an enumerated set, derived here from the canary sources: a new code in ui-canary(-browser).ts that the
// allowlist does not list fails this test instead of silently turning the health line into a count.
const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const browserSource = source("ui-canary-browser.ts"), canarySource = source("ui-canary.ts");
const all = (text: string, re: RegExp) => [...text.matchAll(re)];
function derivedCodes(): { steps: string[]; reasons: string[]; plain: string[]; ticks: string[] } {
  const stepBody = /export function canaryStep[\s\S]*?\n}/.exec(browserSource)![0];
  const steps = new Set([...all(stepBody, /\? "([a-z-]+)"/g), ...all(stepBody, /: "([a-z-]+)";?\s*$/gm)].map(m => m[1]));
  for (const m of all(browserSource, /canaryFailure\("([a-z-]+)", "[a-z-]+"\)/g)) steps.add(m[1]);
  const reasons = new Set<string>();
  const table = /const REASONS[\s\S]*?\n\];/.exec(browserSource)![0];
  for (const row of all(table, /\[\/\^(.*)\$\/, "([^"]+)"\]/g)) {
    const code = row[2];
    if (!code.includes("$")) { reasons.add(code); continue; }
    const groups = all(row[1], /\(([^()]*)\)/g).map(g => g[1].split("|").map(word => word.replace(/ /g, "-")));
    let combos = [""];
    for (const [i] of groups.entries()) combos = combos.flatMap(prefix => groups[i].map(word => (prefix ? `${prefix}-` : "") + word));
    for (const c of combos) reasons.add(c);
  }
  for (const m of all(browserSource, /canaryFailure\(step, "([a-z-]+)"\)/g)) reasons.add(m[1]);
  for (const m of all(browserSource, /canaryFailure\("[a-z-]+", "([a-z-]+)"\)/g)) reasons.add(m[1]);
  for (const m of all(browserSource, /relayFailed\("([a-z-]+)"\)/g)) reasons.add(m[1]);
  reasons.add("exit-1"); reasons.add("exit-137"); reasons.add("exit-signal"); reasons.add("other");
  const plain = new Set<string>();
  for (const m of all(canarySource, /failure = "([a-z0-9-]+)"/g)) plain.add(m[1]);
  const codeFn = /export function canaryFailureCode[\s\S]*?\n}/.exec(canarySource)![0];
  for (const m of all(codeFn, /\? "([a-z0-9-]+)"|: "([a-z0-9-]+)"/g)) plain.add(m[1] ?? m[2]);
  const ticks = all(canarySource, /tick\.push\("([a-z0-9-]+)"\)/g).map(m => m[1]);
  return { steps: [...steps], reasons: [...reasons], plain: [...plain], ticks };
}
describe("ui-canary error codes are an enumerated allowlist", () => {
  const re = new RegExp(`^(?:${canary[0]})$`);
  const line = (code: string) => `[ui-canary] launch gen=1 result=failed error=${code}`;
  const derived = derivedCodes();
  it("derives a plausible set from the sources (the parser itself is checked)", () => {
    expect(derived.steps.sort()).toEqual(["browser", "cdp", "cdp-url", "close", "open", "relay"]);
    for (const r of ["session-not-running", "session-did-not-start", "session-timed-out", "endpoint-lookup-refused", "connect-failed", "unreachable", "busy",
      "stale-instance", "launcher-refused", "spawn-refused", "unavailable", "no-endpoint", "no-page", "error", "disconnected"]) expect(derived.reasons).toContain(r);
    expect(derived.plain.sort()).toEqual(expect.arrayContaining(["aborted", "halted", "no-ui", "timed-out", "other"]));
    expect(derived.ticks).toEqual(expect.arrayContaining(["stale-instance", "teardown-unconfirmed", "instance-write-failed"]));
  });
  it("lists every step-reason code, plain code and tick word the canary can write", () => {
    for (const step of derived.steps) for (const reason of derived.reasons) {
      const code = `${step}-${reason}`;
      expect(re.test(line(code)), code).toBe(true); expect(allowedLogMessage(line(code)), code).toBe(line(code));
    }
    for (const code of derived.plain) expect(re.test(line(code)), code).toBe(true);
    for (const word of derived.ticks) expect(re.test(`[ui-canary] ${word}`), word).toBe(true);
    expect(re.test("[ui-canary] cleanup-busy-exit-75")).toBe(true);
  });
  it("refuses codes outside the set, including arbitrary lowercase text", () => {
    for (const bad of ["pin-4321", "my-bank-pin", "open-pin-4321", "open-launcher-refused-4321", "open-", "x-busy", "exit-1234", "open-exit-1234", "open-exit-", "Open-busy", "open--busy",
      "cdp-url-session-not-running-extra", "0123456789abcdef0123456789abcdef"]) {
      expect(re.test(line(bad)), bad).toBe(false); expect(allowedLogMessage(line(bad)), bad).toBe("[1 line omitted]");
    }
  });
});

describe("the control plane stores the canary line intact", () => {
  it("keeps the error code through upload ingestion and still scrubs every other line", () => {
    const line = "[ui-canary] launch gen=3 result=failed error=open-launcher-refused";
    expect(scrubLogMessage(line)).toBe(line);
    expect(scrubLogMessage("[ui-canary] launch gen=3 result=failed error=open-launcher-refused token=abc")).toBe("[1 line omitted]");
    expect(scrubLogMessage("TypeError [ERR_INVALID_ARG_TYPE]")).toBe("TypeError [ERR_INVALID_ARG_TYPE]");
  });
});
