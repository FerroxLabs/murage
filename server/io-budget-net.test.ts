// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// LOG-CPU-LINEAGE: on 10-31 about 120 MB/s ran between the window and the server for 2.5 hours and the io-budget line could only
// name SQL. The line now says which routes and which stream frame kinds carried the last minute, as counts and bytes: never content, ids or paths.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IoBudget, type IoReading } from "./io-budget.ts";
import { NET_MAX_LABELS, NET_LINE_BYTES_PER_MINUTE, NetMeter, routeLabel } from "./net-meter.ts";

const MINUTE = 60_000, MB = 1048576;

function rig() {
  let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
  const lines: string[] = [], meter = new NetMeter();
  const budget = new IoBudget({ read: () => reading, log: line => lines.push(line), isIdle: () => false, systemOverloaded: () => null, netMinute: () => meter.take() });
  const minute = (cpu = 0.05) => { reading = { at: reading.at + MINUTE, fsWriteBlocks: reading.fsWriteBlocks, cpuMicros: reading.cpuMicros + cpu * MINUTE * 1000 }; return budget.tick(); };
  budget.tick();
  return { lines, meter, minute };
}

describe("io-budget: top routes and frame kinds", () => {
  it("fail-before: a hot minute's line names the routes and frame kinds that carried it, with counts and bytes", () => {
    const { lines, meter, minute } = rig();
    minute(1); minute(1);
    for (let i = 0; i < 900; i++) { meter.noteRoute(routeLabel("POST", "/api/bots/sable/read"), 60_000); meter.noteFrame("bot", 70_000); }
    meter.noteRoute(routeLabel("GET", "/api/health"), 200);
    minute(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("net last 60s: out 111.6 MB");
    expect(lines[0]).toContain("routes: POST /api/bots/:x/read n=900 51.5MB");
    expect(lines[0]).toContain("frames: bot n=900 60.1MB");
  });

  it("a storm the CPU watchdog does not trip on still gets a line, and a quiet minute stays silent", () => {
    const { lines, meter, minute } = rig();
    meter.noteFrame("bot", NET_LINE_BYTES_PER_MINUTE + 1);
    minute();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[io-budget\] traffic; net last 60s: /);
    meter.noteFrame("bot", NET_LINE_BYTES_PER_MINUTE - 1);
    minute(); minute();
    expect(lines).toHaveLength(1);
  });

  it("each line is one minute: the counters start over", () => {
    const { lines, meter, minute } = rig();
    meter.noteFrame("screen", NET_LINE_BYTES_PER_MINUTE + 1);
    minute();
    meter.noteFrame("message", NET_LINE_BYTES_PER_MINUTE + 1);
    minute();
    expect(lines[1]).toContain("message n=1");
    expect(lines[1]).not.toContain("screen");
  });

  it("a route with many small calls is named even when larger ones fill the top by bytes", () => {
    const meter = new NetMeter();
    for (const word of ["bots", "groups", "threads", "memory", "inbox", "skills"]) meter.noteRoute(`GET /api/${word}`, 10 * MB);
    for (let i = 0; i < 5000; i++) meter.noteRoute("GET /api/health", 10);
    expect(meter.take().routes.map(row => row.label)).toContain("GET /api/health");
  });
});

describe("io-budget: what may reach the line", () => {
  it("a route keeps only words of the route table: no id, name, path or query", () => {
    expect(routeLabel("POST", "/api/bots/sable/read")).toBe("POST /api/bots/:x/read");
    expect(routeLabel("POST", "/api/threads/my-tax-return/messages")).toBe("POST /api/threads/:x/messages");
    expect(routeLabel("GET", "/api/attachments/Users%2Fsean%2Fsecret.pdf?token=abc")).toBe("GET /api/attachments/:x");
    expect(routeLabel("GET", "/api/search?q=divorce%20lawyer")).toBe("GET /api/search");
    expect(routeLabel("TRACE", "/etc/passwd")).toBe("OTHER /:x/:x");
    expect(routeLabel(undefined, undefined)).toBe("OTHER /");
  });

  it("a name that spells a route word is still a name (Astra High): the segment after a named collection is never kept", () => {
    expect(routeLabel("POST", "/api/bots/hermes/read")).toBe("POST /api/bots/:x/read");
    expect(routeLabel("GET", "/api/attachments/report")).toBe("GET /api/attachments/:x");
    expect(routeLabel("GET", "/api/skills/slack")).toBe("GET /api/skills/:x");
    expect(routeLabel("GET", "/api/threads/messages/messages")).toBe("GET /api/threads/:x/:x");
    expect(routeLabel("GET", "/api/webhooks/hook-id/attempts/hermes")).toBe("GET /api/webhooks/:x/attempts/:x");
    expect(routeLabel("POST", "/api/bots/sable/tasks/read")).toBe("POST /api/bots/:x/tasks/:x");
  });

  it("a route nobody listed fails closed (Astra High, second pass): nothing after an unknown segment is kept, even a route word", () => {
    expect(routeLabel("GET", "/api/brand-new-thing/hermes/read")).toBe("GET /api/:x/:x/:x");
    expect(routeLabel("GET", "/brand-new/slack")).toBe("GET /:x/:x");
  });

  it("the hydrate question can be answered: a known view is named, any other value is not", () => {
    expect(routeLabel("GET", "/api/bots?view=sidebar")).toBe("GET /api/bots?view=sidebar");
    expect(routeLabel("GET", "/api/threads/abc/messages?limit=5&view=switch")).toBe("GET /api/threads/:x/messages?view=switch");
    expect(routeLabel("GET", "/api/bots?view=my-secret")).toBe("GET /api/bots");
  });

  it("no content reaches the line: bodies are never handed in, and hostile urls and kinds come out as fixed words", () => {
    const { lines, meter, minute } = rig();
    const secret = "private-chat-words";
    meter.noteRoute(routeLabel("POST", `/api/bots/${secret}/messages?text=${secret}#${secret}`), 1);
    meter.noteRoute(routeLabel("GET", `/${secret}/${secret}/${secret}/${secret}/${secret}/${secret}/${secret}/${secret}`), 1);
    meter.noteFrame(secret, NET_LINE_BYTES_PER_MINUTE + 1);
    meter.noteFrame(`bot ${secret}`, 1);
    minute();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("other n=2");
    expect(lines[0]).not.toContain(secret);
    expect(lines[0]).not.toMatch(/private|chat-words/);
  });

  it("memory is bounded: past the cap every new label folds into one row", () => {
    const meter = new NetMeter();
    for (let i = 0; i < NET_MAX_LABELS * 20; i++) meter.noteRoute(`GET /api/bots/${"x".repeat(i % 7)}${i}`, 1);
    meter.noteFrame("bot", 1);
    expect(meter.size()).toBeLessThanOrEqual(NET_MAX_LABELS + 2);
    const taken = meter.take();
    expect(taken.routes.find(row => row.label === "other")?.bytes).toBeGreaterThan(0);
    expect(taken.outBytes).toBe(NET_MAX_LABELS * 20 + 1);
    expect(meter.size()).toBe(0);
  });
});

describe("io-budget: a diagnostic changes nothing", () => {
  it("a logger that throws on the traffic line leaves the minute's verdict and its reset alone", () => {
    let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
    const meter = new NetMeter();
    const budget = new IoBudget({ read: () => reading, log: () => { throw new Error("disk full"); }, isIdle: () => false, systemOverloaded: () => null, netMinute: () => meter.take() });
    budget.tick();
    meter.noteFrame("bot", NET_LINE_BYTES_PER_MINUTE + 1);
    budget.noteBytes("somewhere", 1024);
    reading = { ...reading, at: MINUTE };
    expect(budget.tick()?.tripped).toBe(false);
    expect(budget.pendingBytes("somewhere")).toBe(0);
    expect(budget.pollScale()).toBe(1);
  });
});

describe("io-budget: wiring", () => {
  // The server is not imported here (it starts everything): the rig run reads the line itself; this keeps the two hooks from being lost.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("every response and every broadcast is metered", () => {
    expect(source).toMatch(/const server = createServer\(\(req, res\) => \{\s*const source = routeSource\(req\.method, req\.url\);\s*routeNames\.set\(res, source\);\s*meterResponse\(req, res\);/);
    expect(source).toMatch(/function broadcast\([\s\S]{0,3000}netMeter\.noteFrame\(kind, sent\);/);
  });
});
