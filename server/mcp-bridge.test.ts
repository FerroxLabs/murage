// The bridge's dead-transport watchdog, pinned at the unit level: the 45s
// e2e wait is too slow for the suite, and the property that matters is not
// the constant but the decision table — silence alone never kills, only
// silence PLUS a failed liveness probe does, and traffic always vetoes.
import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Writable } from "node:stream";

import { CONTROL_REFUSAL_PLAIN, CONTROL_UNAVAILABLE_PLAIN } from "./control-client.ts";
import {
  createGateInterceptor,
  createInactivityWatchdog,
  createLineSplitter,
  createMcpBridgeInterceptor,
  pipeMcpLines,
  writeMcpLine,
  runLivenessProbe,
} from "./mcp-bridge.ts";

/** a probe whose answers the test scripts one call at a time */
function scriptedProbe(answers: boolean[]) {
  const calls: Array<(alive: boolean) => void> = [];
  let handed = 0;
  return {
    calls,
    probe: () =>
      new Promise<boolean>((resolve) => {
        calls.push(resolve);
        const next = answers[handed];
        handed += 1;
        if (next !== undefined) resolve(next);
      }),
  };
}

describe("createInactivityWatchdog", () => {
  it("kills only after silence AND a failed probe, then never re-arms", async () => {
    vi.useFakeTimers();
    try {
      const onDead = vi.fn();
      const scripted = scriptedProbe([true, false]);
      createInactivityWatchdog({ inactivityMs: 1_000, probe: scripted.probe, onDead });

      // first silence window: the probe answers alive → no kill, re-armed
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scripted.calls).toHaveLength(1);
      expect(onDead).not.toHaveBeenCalled();

      // second silence window: the probe fails → dead, exactly once
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scripted.calls).toHaveLength(2);
      expect(onDead).toHaveBeenCalledTimes(1);

      // dead is terminal: no timer survives to fire again
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onDead).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats traffic as proof of life, resetting the window and vetoing an in-flight probe", async () => {
    vi.useFakeTimers();
    try {
      const onDead = vi.fn();
      let probeResolvers: Array<(alive: boolean) => void> = [];
      const watchdog = createInactivityWatchdog({
        inactivityMs: 1_000,
        probe: () => new Promise<boolean>((resolve) => probeResolvers.push(resolve)),
        onDead,
      });

      // steady traffic keeps the probe from ever firing
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(900);
        watchdog.touch();
      }
      expect(probeResolvers).toHaveLength(0);

      // silence fires the probe — but a byte arriving WHILE it runs must
      // outrank even a failed answer (a slow screenshot finishing is life)
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probeResolvers).toHaveLength(1);
      watchdog.touch();
      probeResolvers[0]!(false); // SAFETY: length asserted above
      await vi.advanceTimersByTimeAsync(0);
      expect(onDead).not.toHaveBeenCalled();

      // the veto re-armed the window; a stopped watchdog stays quiet
      watchdog.stop();
      probeResolvers = [];
      await vi.advanceTimersByTimeAsync(10_000);
      expect(probeResolvers).toHaveLength(0);
      expect(onDead).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a rejected probe as not alive", async () => {
    vi.useFakeTimers();
    try {
      const onDead = vi.fn();
      createInactivityWatchdog({
        inactivityMs: 1_000,
        probe: () => Promise.reject(new Error("probe spawn failed")),
        onDead,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onDead).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("near-side MCP ping", () => {
  it.each([0, 17, "ping-🐭", null])("preserves request ID %j without consulting the gate", async (id) => {
    const answer = vi.fn();
    const forward = vi.fn();
    const isHeld = vi.fn(async () => true);
    await createMcpBridgeInterceptor({ answer, forward, gate: { isHeld } })(
      JSON.stringify({ jsonrpc: "2.0", method: "ping", id }),
    );
    expect(JSON.parse(answer.mock.calls[0]![0])).toEqual({ jsonrpc: "2.0", id, result: {} });
    expect(forward).not.toHaveBeenCalled();
    expect(isHeld).not.toHaveBeenCalled();
  });

  it("consumes notifications and retains gate forwarding/refusal", async () => {
    const answer = vi.fn();
    const forward = vi.fn();
    const isHeld = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const intercept = createMcpBridgeInterceptor({ answer, forward, gate: { isHeld } });
    await intercept('{"jsonrpc":"2.0","method":"ping"}');
    expect(answer).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    const call = '{"jsonrpc":"2.0","id":4,"method":"tools/call"}';
    await intercept(call);
    expect(JSON.parse(answer.mock.calls[0]![0]).result.isError).toBe(true);
    await intercept(call);
    await intercept("not json");
    expect(forward.mock.calls.map(([line]) => line)).toEqual([call, "not json"]);
  });

  it("negative control: the old gate-only path sends ping to the unsupported driver", async () => {
    const forward = vi.fn();
    const ping = '{"jsonrpc":"2.0","id":0,"method":"ping"}';
    await createGateInterceptor({ isHeld: async () => false, forward, refuse: vi.fn() })(ping);
    expect(forward).toHaveBeenCalledWith(ping);
    forward.mockClear();
    await createMcpBridgeInterceptor({ answer: vi.fn(), forward })(ping);
    expect(forward).not.toHaveBeenCalled();
  });

  it("bounds incomplete frames", () => {
    const splitter = createLineSplitter(() => {}, 8);
    splitter.push("12345678");
    expect(() => splitter.push("9")).toThrow("MCP frame exceeds bridge limit");
  });

  it("keeps injected output whole, waits for slow writes and flushes final fragments", async () => {
    const childOutput = new PassThrough();
    const writes: string[] = [];
    const callbacks: Array<() => void> = [];
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString());
        callbacks.push(callback);
      },
    });
    const done = new Promise<void>((resolve, reject) => {
      pipeMcpLines(childOutput, (line) => writeMcpLine(destination, line), resolve, reject);
    });
    childOutput.write('{"id":1,"res');
    await new Promise((resolve) => setImmediate(resolve));
    const reply = writeMcpLine(destination, '{"id":0,"result":{}}');
    childOutput.end('ult":{}}\n{"id":2,"result":{}}');
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes).toEqual(['{"id":0,"result":{}}\n']);
    expect(childOutput.isPaused()).toBe(true);
    callbacks.shift()!();
    await reply;
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes).toHaveLength(2);
    callbacks.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    callbacks.shift()!();
    await done;
    expect(writes.map((line) => JSON.parse(line).id)).toEqual([0, 1, 2]);
  });

  it("runs the real bridge against an isolated child, including stdin EOF", async () => {
    // This fake driver rejects forwarded ping; it echoes all other frames
    // as a deliberately fragmented result without a final newline.
    const driver = `let input = ''; process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => {
        const frames = input.trim().split('\\n').filter(Boolean).map(JSON.parse);
        const output = JSON.stringify({jsonrpc:'2.0', id:9, result:{methods:frames.map(f=>f.method)}});
        process.stdout.write(output.slice(0, 12));
        setTimeout(() => process.stdout.write(output.slice(12)), 10);
      });`;
    const script = `import {runMcpBridge} from './server/mcp-bridge.ts';
      runMcpBridge({command:process.execPath,args:['-e',${JSON.stringify(driver)}],label:'fixture'});`;
    const bridge = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
      { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    bridge.stdout.on("data", (chunk) => { output += chunk; });
    bridge.stderr.on("data", (chunk) => { errors += chunk; });
    const timer = setTimeout(() => bridge.kill("SIGKILL"), 5000);
    try {
      const closed = new Promise<number | null>((resolve, reject) => {
        bridge.on("error", reject);
        bridge.on("close", resolve);
      });
      bridge.stdin.end('{"jsonrpc":"2.0","id":0,"method":"ping"}\n' +
        '{"jsonrpc":"2.0","method":"ping"}\n{"jsonrpc":"2.0","id":9,"method":"tools/list"}');
      expect(await closed, errors).toBe(0);
      expect(output.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        { jsonrpc: "2.0", id: 0, result: {} },
        { jsonrpc: "2.0", id: 9, result: { methods: ["tools/list"] } },
      ]);
    } finally {
      clearTimeout(timer);
      if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
    }
  });
});

describe("runLivenessProbe", () => {
  it("maps exit status to liveness and treats an unspawnable probe as dead", async () => {
    await expect(
      runLivenessProbe({ command: process.execPath, args: ["-e", "process.exit(0)"] }),
    ).resolves.toBe(true);
    await expect(
      runLivenessProbe({ command: process.execPath, args: ["-e", "process.exit(3)"] }),
    ).resolves.toBe(false);
    await expect(
      runLivenessProbe({ command: "/nonexistent/murage-probe", args: [] }),
    ).resolves.toBe(false);
  });

  it("times out a probe that hangs instead of inheriting the hang", async () => {
    await expect(
      runLivenessProbe({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, 300),
    ).resolves.toBe(false);
  });
});

describe("createLineSplitter", () => {
  it("reassembles lines across arbitrary chunk boundaries", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push('{"a"');
    splitter.push(':1}\n{"b":2}\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c"']);
  });

  it("does not corrupt a UTF-8 character split between buffers", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    const bytes = Buffer.from('{"text":"mouse 🐭"}\n');
    const splitAt = bytes.indexOf(Buffer.from("🐭")) + 2;
    splitter.push(bytes.subarray(0, splitAt));
    splitter.push(bytes.subarray(splitAt));
    splitter.flush();
    expect(lines).toEqual(['{"text":"mouse 🐭"}']);
  });
});

describe("createGateInterceptor", () => {
  const frame = (method: string, id?: number) => JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
  const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

  function harness(isHeld: () => Promise<boolean>) {
    const forwarded: string[] = [];
    const refused: string[] = [];
    const intercept = createGateInterceptor({
      isHeld,
      forward: (line) => forwarded.push(line),
      refuse: (line) => refused.push(line),
    });
    return { forwarded, refused, intercept };
  }

  it("forwards everything untouched while nobody is driving", async () => {
    const { forwarded, refused, intercept } = harness(async () => false);
    for (const line of [frame("initialize", 1), frame("tools/list", 2), frame("tools/call", 3), "not json at all"]) {
      intercept(line);
    }
    await drain();
    expect(refused).toEqual([]);
    expect(forwarded).toHaveLength(4);
    // byte-for-byte: the transparent path must not re-serialize a frame
    expect(forwarded[3]).toBe("not json at all");
  });

  it("refuses only tools/call while the person is driving", async () => {
    const { forwarded, refused, intercept } = harness(async () => true);
    intercept(frame("tools/list", 1));
    intercept(frame("tools/call", 2));
    await drain();
    expect(forwarded).toEqual([frame("tools/list", 1)]);
    expect(refused).toHaveLength(1);
    const answer = JSON.parse(refused[0]!);
    expect(answer.id).toBe(2);
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toMatch(/taken control/i);
  });

  it("preserves protocol order even though the held-check is async", async () => {
    const order: string[] = [];
    let calls = 0;
    let releaseFirst!: (held: boolean) => void;
    const first = new Promise<boolean>((resolve) => (releaseFirst = resolve));
    let drained!: () => void;
    const allForwarded = new Promise<void>((resolve) => (drained = resolve));
    const intercept = createGateInterceptor({
      isHeld: () => (calls++ === 0 ? first : Promise.resolve(false)),
      forward: (line) => {
        const parsed = JSON.parse(line);
        order.push(`fwd:${parsed.id ?? parsed.marker}`);
        if (parsed.marker === "drained") drained();
      },
      refuse: (line) => order.push(`ref:${JSON.parse(line).id}`),
    });
    intercept(frame("tools/call", 1));
    intercept(frame("tools/call", 2));
    intercept(JSON.stringify({ marker: "drained" }));
    expect(order).toEqual([]);
    releaseFirst(false);
    await allForwarded;
    expect(order).toEqual(["fwd:1", "fwd:2", "fwd:drained"]);
  });

  // 0.1.52 decision U-11 (audit A5) changed the intended behaviour here: this
  // case used to assert fail-open forwarding. A configured gate that cannot
  // read the hold now refuses the tool call with reconnect guidance.
  it("fails closed: a broken held-check refuses tools/call with reconnect guidance", async () => {
    const { forwarded, refused, intercept } = harness(async () => {
      throw new Error("harness went away");
    });
    intercept(frame("tools/call", 1));
    intercept(frame("tools/list", 2));
    await drain();
    expect(forwarded).toEqual([frame("tools/list", 2)]);
    expect(refused).toHaveLength(1);
    const answer = JSON.parse(refused[0]!);
    expect(answer.id).toBe(1);
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toBe(CONTROL_UNAVAILABLE_PLAIN);
    expect(answer.result.content[0].text).toMatch(/NOT performed/);
    expect(answer.result.content[0].text).toMatch(/reconnect/);
  });
});

// Failure injection through the real bridge process: a configured control
// endpoint that is down, erroring or malformed must never let a tools/call
// reach the driver; a well-formed answer keeps the old held/free behaviour.
describe("runMcpBridge held-control gate", () => {
  const driver = `let input = ''; process.stdin.on('data', c => input += c);
    process.stdin.on('end', () => {
      const frames = input.trim().split('\\n').filter(Boolean).map(JSON.parse);
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:9, result:{methods:frames.map(f=>f.method)}}) + '\\n');
    });`;

  async function controlServer(respond: (res: import("node:http").ServerResponse) => void): Promise<{ server: Server; url: string; hits: string[] }> {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(String(req.headers.authorization ?? ""));
      respond(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${port}/api/internal/computer-control?botId=fixture`, hits };
  }

  async function runGated(url: string) {
    const script = `import {runMcpBridge} from './server/mcp-bridge.ts';
      runMcpBridge({command:process.execPath,args:['-e',${JSON.stringify(driver)}],label:'fixture',
        gate:{url:${JSON.stringify(url)},token:'fixture-token'}});`;
    const bridge = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MURAGE_CONTROL_URL: "", MURAGE_CONTROL_TOKEN: "" } });
    let output = "";
    let errors = "";
    bridge.stdout.on("data", (chunk) => { output += chunk; });
    bridge.stderr.on("data", (chunk) => { errors += chunk; });
    const timer = setTimeout(() => bridge.kill("SIGKILL"), 8000);
    try {
      const closed = new Promise<number | null>((resolve, reject) => {
        bridge.on("error", reject);
        bridge.on("close", resolve);
      });
      bridge.stdin.end('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"click"}}\n' +
        '{"jsonrpc":"2.0","id":6,"method":"tools/list"}\n');
      expect(await closed, errors).toBe(0);
      return output.trim().split("\n").map((line) => JSON.parse(line));
    } finally {
      clearTimeout(timer);
      if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
    }
  }

  const unavailable = [
    ["a non-2xx answer", (res: import("node:http").ServerResponse) => { res.writeHead(503).end("{}"); }],
    ["a malformed body", (res: import("node:http").ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }).end('{"held":"no"}'); }],
    ["a non-JSON body", (res: import("node:http").ServerResponse) => { res.writeHead(200).end("<html>proxy error</html>"); }],
  ] as const;

  it.each(unavailable)("refuses tools/call with reconnect guidance on %s and still forwards other frames", async (_label, respond) => {
    const control = await controlServer(respond);
    try {
      const frames = await runGated(control.url);
      expect(frames).toEqual([
        { jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: CONTROL_UNAVAILABLE_PLAIN }], isError: true } },
        { jsonrpc: "2.0", id: 9, result: { methods: ["tools/list"] } },
      ]);
      expect(control.hits).toEqual(["Bearer fixture-token"]);
    } finally {
      await new Promise((resolve) => control.server.close(resolve));
    }
  });

  it("refuses tools/call with reconnect guidance when the control endpoint is unreachable", async () => {
    const control = await controlServer((res) => { res.end(); });
    await new Promise((resolve) => control.server.close(resolve));
    const frames = await runGated(control.url);
    expect(frames).toEqual([
      { jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: CONTROL_UNAVAILABLE_PLAIN }], isError: true } },
      { jsonrpc: "2.0", id: 9, result: { methods: ["tools/list"] } },
    ]);
  });

  it("keeps the known held and free behaviour for a well-formed answer", async () => {
    const free = await controlServer((res) => { res.writeHead(200, { "content-type": "application/json" }).end('{"held":false,"helpOpen":false}'); });
    try {
      expect(await runGated(free.url)).toEqual([{ jsonrpc: "2.0", id: 9, result: { methods: ["tools/call", "tools/list"] } }]);
    } finally {
      await new Promise((resolve) => free.server.close(resolve));
    }
    const held = await controlServer((res) => { res.writeHead(200, { "content-type": "application/json" }).end('{"held":true,"helpOpen":false}'); });
    try {
      expect(await runGated(held.url)).toEqual([
        { jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: CONTROL_REFUSAL_PLAIN }], isError: true } },
        { jsonrpc: "2.0", id: 9, result: { methods: ["tools/list"] } },
      ]);
    } finally {
      await new Promise((resolve) => held.server.close(resolve));
    }
  });
});
