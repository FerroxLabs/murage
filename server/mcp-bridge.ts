import { withHideInherit } from "../shared/win-hide-child-process.mjs";
import { createMcpCatalogWriter } from "./mcp-listed.ts";
import { bridgeBusyFrame, createBridgeIds, spliceTopLevelId, topLevelIdText } from "./mcp-bridge-ids.ts";
export { bridgeBusyFrame } from "./mcp-bridge-ids.ts";
// The one transparent stdio bridge behind both MCP entry points
// (container-mcp.ts for the Local VM, vps-container-mcp.ts for the BYO VPS).
// It defines no tools. MCP ping is answered locally because the bundled
// driver does not implement it; ping notifications are consumed silently.
//
// The other exception to transparency is the who-is-driving gate
// (opt-in via `gate`). While the person holds control of this computer in
// the app, a `tools/call` from the agent is answered with a refusal HERE,
// on the near side, and never forwarded — Cua Driver on the far side has
// no concept of a person holding the wheel, so the refusal cannot come
// from anywhere else. Everything that is not a tools/call still passes
// through untouched, and with no gate configured the bridge remains the
// frame-preserving pipe (apart from local ping replies).
//
// The third exception is the answer to a `tools/list`. Every engine passes a
// tool's inputSchema to its model provider, and strict providers refuse a
// root that is not a plain object, failing the whole turn. That answer is
// rewritten to a provider-safe root (mcp-tool-schema.ts, upstream #1390);
// the far end still validates each call against its own schema.
//
// The fourth is an error result carrying a screenshot or other non-text
// content: the Anthropic API refuses a non-text is_error tool_result and fails
// the whole turn, so such a result keeps its text and drops the rest, with a
// note saying so (mcp-error-result.ts, upstream #3181).
//
// A configured gate fails CLOSED (0.1.52 decision U-11, audit A5): when the
// harness control endpoint times out, errors or answers malformed, nobody can
// say the person is not driving, so a tools/call is refused with reconnect
// guidance instead of being forwarded.
//
// Two behaviors live here so neither entry point can drift:
//   1. Exit without truncation. `process.exit()` in a close/error handler
//      discards whatever is still buffered on stdout — a final MCP result
//      would be cut mid-frame. The bridge sets exitCode and unpipes instead,
//      letting stdio drain before the process ends on its own.
//   2. A dead-transport watchdog (opt-in via `liveness`). docker's ssh
//      connection helper accepts no ConnectTimeout/ServerAlive options, so a
//      VPS dropping mid-turn leaves the exec silently wedged until the OS
//      gives up — the harness sees a hung tool call, not an error.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

import {
  CONTROL_REFUSAL_PLAIN,
  CONTROL_UNAVAILABLE_PLAIN,
  ControlUnavailableError,
  createControlClient,
} from "./control-client.ts";
import { augmentedPath, resolveCliSpawn } from "./env-path.ts";
import { textOnlyErrorResultLine } from "./mcp-error-result.ts";
import { createToolListNormalizer } from "./mcp-tool-schema.ts";

// 45s of TOTAL silence before the bridge even probes. An MCP session is
// legitimately quiet between tool calls and a slow screenshot can take tens
// of seconds, so silence alone never kills anything — it only triggers a
// liveness probe, and only a probe that FAILS ends the bridge. Any byte on
// stdin/stdout/stderr resets the window.
export const BRIDGE_INACTIVITY_MS = 45_000;
const PROBE_TIMEOUT_MS = 10_000;
// Screenshots can be large; still cap an unterminated/malformed frame.
export const MAX_BRIDGE_FRAME_BYTES = 32 * 1024 * 1024;

export interface BridgeLiveness {
  command: string;
  args: string[];
}

/** Run the liveness command; alive means "exited 0 within the timeout". The
 * probe is its own short-lived process, so it cannot inherit the wedged
 * connection it is diagnosing. */
export function runLivenessProbe(probe: BridgeLiveness, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(probe.command, [...probe.args], withHideInherit({
      shell: false,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["ignore", "ignore", "ignore"],
    }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export interface WatchdogHandle {
  /** Any traffic in either direction — resets the inactivity window. */
  touch: () => void;
  stop: () => void;
}

/** Inactivity → probe → (only then) declare dead. Traffic arriving while a
 * probe is in flight vetoes even a failed probe: bytes are better evidence
 * of life than a health command racing a congested link. */
export function createInactivityWatchdog(options: {
  inactivityMs: number;
  probe: () => Promise<boolean>;
  onDead: () => void;
}): WatchdogHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let probing = false;
  let touchedWhileProbing = false;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(fire, options.inactivityMs);
    timer.unref?.();
  };
  const settleProbe = (alive: boolean) => {
    probing = false;
    if (stopped) return;
    if (alive || touchedWhileProbing) {
      arm();
      return;
    }
    options.onDead();
  };
  const fire = () => {
    probing = true;
    touchedWhileProbing = false;
    void options.probe().then(settleProbe, () => settleProbe(false));
  };

  arm();
  return {
    touch() {
      if (stopped) return;
      if (probing) {
        touchedWhileProbing = true;
        return;
      }
      if (timer) clearTimeout(timer);
      arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export interface BridgeOptions {
  command: string;
  args: string[];
  /** Names the far end in stderr messages, e.g. "Cua Driver". */
  label: string;
  /** Enables the dead-transport watchdog. Omitted for the Local VM, whose
   * runtime CLI talks to a local daemon and fails fast on its own. */
  liveness?: BridgeLiveness;
  /** Enables the who-is-driving gate: the harness's loopback control
   * endpoint plus its per-boot token. Absent → fully transparent bridge. */
  gate?: { url: string; token: string | (() => string) };
  /** The most requests allowed to wait at once (default MAX_BRIDGE_IN_FLIGHT). A test seam for the cap. */
  maxInFlight?: number;
  childEnv?: NodeJS.ProcessEnv;
  observeTools?: (tools:unknown[],replace:boolean)=>Promise<void>;
}

/** Collect a byte stream into complete newline-terminated lines. MCP's
 * stdio transport is one JSON-RPC frame per line, so line boundaries are
 * the only safe place to inspect — or inject — anything. */
export function createLineSplitter(onLine: (line: string) => void, maxBytes = MAX_BRIDGE_FRAME_BYTES): {
  push: (chunk: Buffer | string) => void;
  flush: () => void;
} {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        if (Buffer.byteLength(line) > maxBytes) throw new Error("MCP frame exceeds bridge limit");
        pending = pending.slice(newline + 1);
        onLine(line);
      }
      if (Buffer.byteLength(pending) > maxBytes) throw new Error("MCP frame exceeds bridge limit");
    },
    flush() {
      pending += decoder.end();
      if (pending) onLine(pending);
      pending = "";
    },
  };
}

const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
/** The first MCP revision whose clients reject a result without `resultType`. */
export const RESULT_TYPE_PROTOCOL = "2026-07-28";

/** An answer the bridge writes itself (a gate refusal, a ping reply) says it is complete when the request came from a
 * client on revision 2026-07-28 or later, which rejects a result without `resultType` and would show the bot
 * "missing required resultType" instead of the reason. The driver's own answers already carry it. Older clients, and a
 * result that already names its type, get the result unchanged (the same object). */
export function completeFor(meta: unknown, result: unknown): unknown {
  const version = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>)[PROTOCOL_VERSION_META] : undefined;
  if (typeof version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(version) || version < RESULT_TYPE_PROTOCOL) return result;
  if (!result || typeof result !== "object" || Array.isArray(result) || "resultType" in result) return result;
  return { ...result, resultType: "complete" };
}

/** The gate itself, factored free of process wiring so a test can drive it
 * with plain strings. Frames are handled on a serialized queue: the
 * held-check is async, and answering frame N+1 before frame N would
 * reorder the agent's protocol stream. Only a `tools/call` is ever
 * refused; every other frame — handshakes, tools/list, notifications,
 * lines that are not JSON — passes through untouched.
 *
 * A held-check that rejects means the hold is unknown. The gate then fails
 * closed: the tools/call is refused with `unavailableText` (reconnect
 * guidance), never forwarded. */
export function createGateInterceptor(options: {
  isHeld: () => Promise<boolean>;
  forward: (line: string) => unknown;
  refuse: (line: string) => unknown;
  refusalText?: string;
  unavailableText?: string;
}): (line: string) => Promise<void> {
  const refusalText = options.refusalText ?? CONTROL_REFUSAL_PLAIN;
  const unavailableText = options.unavailableText ?? CONTROL_UNAVAILABLE_PLAIN;
  let queue: Promise<void> = Promise.resolve();
  return (line: string) => {
    queue = queue.then(async () => {
      let frame: any = null;
      try {
        frame = JSON.parse(line);
      } catch {
        // not a frame this gate understands — never stand between the
        // agent and its driver on anything but a recognized tool call
      }
      if (!frame || frame.method !== "tools/call") {
        await options.forward(line);
        return;
      }
      const verdict = await options.isHeld().then(
        (held) => (held ? "held" : "free"),
        () => "unavailable" as const,
      );
      if (verdict === "free") {
        await options.forward(line);
        return;
      }
      await options.refuse(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id ?? null,
          result: completeFor(frame.params?._meta, {
            content: [{ type: "text", text: verdict === "held" ? refusalText : unavailableText }],
            isError: true,
          }),
        }),
      );
    });
    return queue;
  };
}

export function createMcpBridgeInterceptor(options: {
  answer: (line: string) => unknown;
  forward: (line: string) => unknown;
  gate?: { isHeld: () => Promise<boolean>; refusalText?: string; unavailableText?: string };
}): (line: string) => Promise<void> {
  const afterPing = options.gate
    ? createGateInterceptor({ ...options.gate, forward: options.forward, refuse: options.answer })
    : options.forward;
  return async (line) => {
    let frame: any;
    try { frame = JSON.parse(line); } catch { /* Forward unrecognized input unchanged. */ }
    if (frame?.method === "ping") {
      if (frame.id !== undefined) {
        await options.answer(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: completeFor(frame.params?._meta, {}) }));
      }
      return;
    }
    await afterPing(line);
  };
}

/** Pause the source while each chunk's complete frames drain. This bounds
 * queued work to one readable chunk plus one incomplete frame, including
 * when the gate or the output consumer is slow. EOF waits for queued work. */
export function pipeMcpLines(source: Readable, handle: (line: string) => unknown,
  end: () => void, fail: (error: Error) => void): () => void {
  let lines: string[] = [];
  const splitter = createLineSplitter((line) => { lines.push(line); });
  let queue = Promise.resolve();
  let stopped = false;
  const drain = async () => {
    const batch = lines;
    lines = [];
    for (const line of batch) {
      if (stopped) return;
      await handle(line);
    }
  };
  const stop = () => {
    stopped = true;
    source.off("data", onData);
    source.off("end", onEnd);
    source.pause();
  };
  const failed = (error: Error) => { stop(); fail(error); };
  const onData = (chunk: Buffer) => {
    source.pause();
    queue = queue.then(async () => {
      splitter.push(chunk);
      await drain();
      if (!stopped) source.resume();
    }).catch(failed);
  };
  const onEnd = () => {
    queue = queue.then(async () => {
      if (stopped) return;
      splitter.flush();
      await drain();
      if (!stopped) end();
    }).catch(failed);
  };
  source.on("data", onData);
  source.on("end", onEnd);
  return stop;
}

/** One write per complete frame prevents injected replies from splitting
 * child output. Awaiting the callback also propagates output backpressure. */
export function writeMcpLine(destination: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    destination.write(line + "\n", (error) => error ? reject(error) : resolve());
  });
}

export function runMcpBridge(options: BridgeOptions): void {
  // On Windows a bare name or a .cmd/.bat shim (npx, a package's bin) cannot be
  // started by a plain spawn; resolve it the way every engine launch does
  // (OpenMausBot #2055, Apache-2.0). Identity on other systems.
  const resolved = resolveCliSpawn(options.command, options.args);
  const child = spawn(resolved.command, [...resolved.args], withHideInherit({
    shell: false,
    env: options.childEnv ?? { ...process.env, PATH: augmentedPath() },
    stdio: ["pipe", "pipe", "pipe"],
  }));

  // docker may exit before it drains stdin; pipe() leaves this error unhandled.
  child.stdin.on("error", () => {});
  child.stderr.pipe(process.stderr);

  const client = options.gate
    ? createControlClient({ url: options.gate.url, token: options.gate.token }) : null;
  const catalog = createMcpCatalogWriter(process.env, process.stdout);
  // The child never sees an engine request id (C11 note 3.1 section 6): every request goes on under a bridge id, and an
  // answer is delivered only through the handle of the live entry that issued that exact id, once, with the engine's id put back.
  const toolLists = createToolListNormalizer();
  const effectLists = new Map<string|number,boolean>();
  const ids = createBridgeIds({
    ...(options.maxInFlight !== undefined ? { cap: options.maxInFlight } : {}),
    onRetire: (entry, how) => {
      toolLists.forget(entry.bridgeId);
      if (how === "revoked") process.stderr.write(`${options.label} bridge revoked an answer that was waiting to be written\n`);
    },
  });
  const maxInFlight = options.maxInFlight;
  const shapeOf = (line: string): { key?: string; request: boolean; response: boolean; value?: any } => {
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== "object" || Array.isArray(value)) return { request: false, response: false };
      const key = ids.engineKeyOf(value.id);
      const hasMethod = typeof value.method === "string";
      return { key, request: hasMethod && key !== undefined, response: !hasMethod && key !== undefined, value };
    } catch { return { request: false, response: false }; }
  };
  const droppedLine = () => process.stderr.write(`${options.label} bridge dropped a response that answers no waiting request\n`);
  // Every frame to the engine goes through the writer. A response leaves through the handle of its live entry; anything else is a plain send.
  const answer = (line: string): Promise<void> => {
    const { response, value } = shapeOf(line);
    if (response) {
      const taken = ids.take(value.id);
      if (taken.kind === "live") {
        const { entry } = taken;
        const out = spliceTopLevelId(line, entry.engineIdRaw) ?? line;
        // A settled id is gone from the normalizer too, whatever shape the answer had (Astra 19f M1): nothing may outlive its entry.
        return entry.req.respond(out, undefined, { stillWanted: () => entry.state === "claimed" }).finally(() => { toolLists.forget(entry.bridgeId); ids.settle(entry); });
      }
      if (taken.kind === "retired" || taken.collides) { droppedLine(); return Promise.resolve(); }
    }
    return catalog.send(line);
  };
  const transportFailed = (error: Error) => {
    process.stderr.write(`${options.label} bridge stream failed: ${error.message}\n`);
    process.exitCode = 1;
    watchdog?.stop();
    detach();
    child.kill("SIGKILL");
  };
  const intercept = createMcpBridgeInterceptor({
    answer,
    forward: async (line) => {
      try {
        await writeMcpLine(child.stdin, line);
      } catch (error) {
        // Docker may close stdin before consuming a request. Stop feeding it,
        // but let its close event report the actual transport exit status.
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
        // The request never reached the server: no response is owed, and the child's close ends the process.
        const { request, value } = shapeOf(line);
        if (request && typeof value.id === "string") ids.retire(value.id);
        detach();
      }
    },
    ...(client
      ? {
        gate: {
          isHeld: async () => {
            const state = await client.state(true);
            // Unknown is not "free": the gate refuses with reconnect guidance.
            if (!state.available) throw new ControlUnavailableError();
            return state.held;
          },
        },
      }
      : {}),
  });
  const detach = pipeMcpLines(process.stdin, async (original) => {
    // 1. The catalog observer stays keyed on the engine's id.
    const req = catalog.observeRequest(original);
    const { key, request, value } = shapeOf(original);
    let line = original;
    if (request && key !== undefined) {
      // 2. A request goes on under a bridge id. At the cap it is answered busy through its own tracked entry, and the next
      // engine line is not read until that answer is written or revoked, so there is never more than one busy entry.
      const raw = topLevelIdText(original);
      const issued = raw === undefined ? undefined : ids.issue(key, raw, req);
      if (issued && !issued.admitted) {
        const { entry } = issued;
        await req.respond(bridgeBusyFrame(value.id, maxInFlight), () => bridgeBusyFrame(value.id, maxInFlight), { stillWanted: () => entry.state === "claimed" })
          .finally(() => ids.settle(entry));
        return;
      }
      const spliced = issued?.admitted ? spliceTopLevelId(original, JSON.stringify(issued.bridgeId)) : undefined;
      if (issued?.admitted && spliced === undefined) ids.retire(issued.bridgeId);
      if (spliced !== undefined) line = spliced;
    } else if (value?.method === "notifications/cancelled" && ids.engineKeyOf(value.params?.requestId) !== undefined) {
      // 3. A cancel names the child's id for the request, or nothing live: then it is dropped.
      const bid = ids.cancelByEngine(ids.engineKeyOf(value.params.requestId)!);
      if (bid === undefined) return;
      line = JSON.stringify({ ...value, params: { ...value.params, requestId: bid } });
    }
    // 4. The normalizer's pending set is keyed on bridge ids, which is what the child echoes.
    await req.published;
    toolLists.observeRequest(line);
    if(options.observeTools){const frame=shapeOf(line).value;if(frame?.method==='tools/list'&&frame.id!==undefined)effectLists.set(frame.id,!frame.params?.cursor);}
    return intercept(line);
  }, () => child.stdin.end(), transportFailed);
  // The write of a child answer is not awaited before the next child line is read (the writer's own order is unchanged).
  pipeMcpLines(child.stdout, (line) => {
    if(!options.observeTools){answer(textOnlyErrorResultLine(toolLists.rewriteResponse(line))).catch(transportFailed);return;}
    return (async()=>{
      const frame=shapeOf(line).value,replace=effectLists.get(frame?.id);
      if(replace!==undefined){effectLists.delete(frame.id);if(Array.isArray(frame.result?.tools))await options.observeTools!(frame.result.tools,replace);}
      await answer(textOnlyErrorResultLine(toolLists.rewriteResponse(line)));
    })();
  }, () => {}, transportFailed);

  let watchdog: WatchdogHandle | null = null;
  if (options.liveness) {
    const liveness = options.liveness;
    watchdog = createInactivityWatchdog({
      inactivityMs: BRIDGE_INACTIVITY_MS,
      probe: () => runLivenessProbe(liveness),
      onDead: () => {
        process.stderr.write(
          `${options.label} transport went silent and stopped answering liveness probes; ending the bridge\n`,
        );
        process.exitCode = 1;
        detach();
        child.kill("SIGKILL");
        // A docker wedged on a dead ssh connection may never deliver close.
        // Nothing can be buffered on stdout after 45 quiet seconds, so this
        // hard exit — unlike the close-handler one this file exists to avoid —
        // cannot truncate anything.
        const failsafe = setTimeout(() => process.exit(1), 2_000);
        failsafe.unref?.();
      },
    });
    const touch = () => watchdog?.touch();
    process.stdin.on("data", touch);
    child.stdout.on("data", touch);
    child.stderr.on("data", touch);
  }

  child.on("error", (error) => {
    process.stderr.write(`could not connect to ${options.label}: ${error.message}\n`);
    process.exitCode = 1;
    watchdog?.stop();
    detach();
  });
  child.on("close", (code, signal) => {
    if (signal) process.stderr.write(`${options.label} connection ended with ${signal}\n`);
    // Let stdout and stderr drain before the bridge exits.
    process.exitCode = process.exitCode ?? code ?? 1;
    watchdog?.stop();
    detach();
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => child.kill(signal));
  }
}
