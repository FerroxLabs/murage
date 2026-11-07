import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// THE HOME'S HALF OF A FIRST-RUN PRESS, MEASURED ON A REAL SERVER.
//
// The owner pressed Continue on a fresh Cloud home and waited seconds. The
// renderer answers the press at once now; this proves the server says where
// its own time went on every setup answer, phase by phase, on a Server-Timing
// header the renderer reads (src/lib/first-run-timing.ts). It also prints the
// phases for a run of answers on the fake engine, which is the server-side
// measurement the lane reports.
let fixture: VerificationServer;
let desktop: Record<string, string>;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const started = performance.now();
  const response = await fetch(`${fixture.info.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...desktop, ...headers },
    body: JSON.stringify(body),
  });
  await response.json();
  return { status: response.status, timing: response.headers.get("server-timing") ?? "", rtt: performance.now() - started };
}

function phases(header: string): Record<string, number> {
  return Object.fromEntries(header.split(",").map((part) => {
    const [name, dur] = part.trim().split(";dur=");
    return [name, Number(dur)];
  }));
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then((response) => response.json() as Promise<{ secret: string }>);
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  // The renderer's first read seats the Chief; a person cannot answer a card that was never drawn.
  await fetch(`${fixture.info.url}/api/setup`, { headers: desktop });
});

afterAll(async () => { await fixture?.close(); });

describe("a setup answer on a real server", () => {
  it("says on a Server-Timing header where its time went, phase by phase", async () => {
    const answered = await post("/api/setup/answer", { step: "hello", answer: "Timing Owner" }, { "x-murage-press-ms": "40" });
    expect(answered.status).toBe(200);
    const got = phases(answered.timing);
    for (const name of ["live", "apps", "engines", "record", "drive", "total"]) expect(Number.isFinite(got[name]), `${name} in ${answered.timing}`).toBe(true);
    // Never the answer itself: it is a name on this step.
    expect(answered.timing).not.toContain("Timing Owner");
  });

  it("times a skip and a reopen the same way", async () => {
    const skipped = await post("/api/setup/skip", { step: "detect" });
    const reopened = await post("/api/setup/reopen", { step: "detect" });
    for (const [route, sent] of [["skip", skipped], ["reopen", reopened]] as const) {
      expect(sent.status, route).toBe(200);
      const got = phases(sent.timing);
      for (const name of ["live", "record", "drive", "total"]) expect(Number.isFinite(got[name]), `${route} ${name} in ${sent.timing}`).toBe(true);
    }
  });

  it("answers the name on the fake engine well inside a second, and prints the phases", async () => {
    const runs: Array<Record<string, number>> = [];
    for (let index = 0; index < 8; index += 1) {
      const answered = await post("/api/setup/answer", { step: "hello", answer: `Owner ${index}` });
      expect(answered.status).toBe(200);
      const got = phases(answered.timing);
      for (const name of ["live", "apps", "engines", "record", "drive", "total"]) expect(Number.isFinite(got[name]), `${name} in ${answered.timing}`).toBe(true);
      runs.push({ ...got, rtt: Math.round(answered.rtt) });
    }
    const median = (name: string) => [...runs.map((run) => run[name] ?? 0)].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    console.info(`[setup-timing-measure] fake engine, ${runs.length} hello answers, median ms: ${["prepare", "echo", "apps", "engines", "live", "record", "drive", "total", "rtt"].map((name) => `${name}=${median(name)}`).join(" ")}`);
    expect(median("total")).toBeLessThan(1_000);
  });
});
