// control: real subprocess transport with isolated lineage, authority and ingress.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirSync } from "./cleanup.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { pathIsWithin, registerTestHandle } from "../test-handle-registry.ts";
import { expect } from "vitest";
const hasIngress = existsSync(new URL("../consuming-turn-ingress.ts", import.meta.url));
const fixtureApi = hasIngress ? await import("./consuming-fixture.ts") : undefined;
const ingressApi = hasIngress ? await import("../consuming-turn-ingress.ts") : undefined;
const responseApi = hasIngress ? await import("../consuming-turn-response.ts") : undefined;
const consumingFixture = (...args: Parameters<NonNullable<typeof fixtureApi>["consumingFixture"]>) => fixtureApi!.consumingFixture(...args);
const createProxyReleaseAuthority = (...args: Parameters<NonNullable<typeof ingressApi>["createProxyReleaseAuthority"]>) => ingressApi!.createProxyReleaseAuthority(...args);
const decodeReleaseEnvelope = (...args: Parameters<NonNullable<typeof ingressApi>["decodeReleaseEnvelope"]>) => ingressApi!.decodeReleaseEnvelope(...args);
const registerConsumingDescriptor = (...args: Parameters<NonNullable<typeof responseApi>["registerConsumingDescriptor"]>) => responseApi!.registerConsumingDescriptor(...args);

// red-at-fc2aad5b4: process exit, not inherited stdio closure, owns the home.
// Keep cleanup.waitForExit's close contract intact for its other callers.
function stopBoundChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disposePipes = () => {
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      // stdio retains the original pipes when spawnBoundProxy replaces facades.
      for (const stream of child.stdio) stream?.destroy();
      if (child.connected) child.disconnect();
    };
    const done = () => {
      if (timer) clearTimeout(timer);
      child.off("exit", done);
      disposePipes(); resolve();
    };
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    child.once("exit", done);
    child.kill("SIGTERM");
    disposePipes();
    timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
      child.kill("SIGKILL");
      timer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
        child.off("exit", done);
        reject(new Error("fixture exit unconfirmed count=1"));
      }, 2000);
    }, 1000);
  });
}

export async function runBoundBridge(script: string, requests: string[], count: number, eof = false,
  options: { role?: string; flipBeforeDelivery?: boolean; race?: "replacement" | "drain" | "transport"; env?: NodeJS.ProcessEnv; raceAtSequence?: number;
    /** A loaded server: the first verdict / the first upstream reserve is answered this many ms late (the answer itself is unchanged). */
    slowVerdictMs?: number; slowUpstreamMs?: number;
    /** cause22-one-rule owner rows: the turn's budget is bound with the owner keep (as index.ts binds an owner turn) and the child
     * meets the release door handler index.ts runs (turn-release-door.ts handleTurnReleaseDoor), so the door names the owner's turn. */
    owner?: boolean;
    /** ms to wait (after the previous request) before request i is offered; request indexes in `raw` go straight to the child's stdin
     * (the child's own line cap is the hop under test, not the relay's ingress in front of it). */
    delays?: number[]; raw?: number[]; timeoutMs?: number } = {}): Promise<string[]> {
  // This fixture-only supervisor notice follows the real entry's import and
  // launch call. A syntax/import failure must not pass a zero-output case.
  script += '\nprocess.send?.({ type: "fixture-entry-ready" });';
  // Execute the actual old entry at b18. Its ordinary stdout reaches the
  // test's zero-delivery assertion; no replacement release implementation is
  // supplied to the old code and no missing module prevents collection.
  if (!hasIngress) {
    const home = mkdtempSync(join(tmpdir(), "murage-baseline-proxy-"));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH, ...options.env, HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: home, NODE_ENV: "test" },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let terminal: unknown;
      child.on("message", message => {
        if ((message as { type?: string })?.type === "fixture-entry-ready") {
          for (const request of requests) child.stdin!.write(request + "\n");
          if (eof) child.stdin!.end();
        } else terminal = message;
      });
      const output = await new Promise<string[]>((resolve, reject) => {
        const output: string[] = []; let pending = "";
        timer = setTimeout(() => reject(new Error("baseline fixture timeout")), 8000);
        child.stderr!.resume(); child.on("error", reject);
        child.stdin!.on("error", reject); child.stdout!.on("error", reject);
        child.stdout!.setEncoding("utf8").on("data", chunk => {
          pending += chunk;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            output.push(pending.slice(0, newline)); pending = pending.slice(newline + 1);
            if (output.length >= Math.max(1, count)) resolve(output);
          }
        });
        child.once("close", () => resolve(output));
      });
      if (count === 0 && output.length === 0) {
        // A legacy EOF with no ordinary frame is not a passing terminal test:
        // it never tells an authenticated supervisor to seal the original lease.
        expect(terminal, "transport loss must send the bound supervisor refusal, not merely exit silently")
          .toMatchObject({ type: "turn-release-terminal", frame: { error: { code: -32099, data: { terminal: true } } } });
      }
      return output;
    } finally {
      if (timer) clearTimeout(timer);
      await stopBoundChild(child);
      removeTempDirSync(home);
    }
  }
  const fixture = consumingFixture(undefined, options.owner ? { continuePending: () => true } : {});
  const ownerDoor = options.owner ? await import("../turn-release-door.ts").then(module => module.handleTurnReleaseDoor, () => undefined) : undefined;
  const isolatedHome = mkdtempSync(join(tmpdir(), "murage-bound-proxy-"));
  const caps = new InternalCapabilities(); caps.begin("B", "T", fixture.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(caps);
  const instance = authority.register(fixture.binding, registerConsumingDescriptor(`proxy:${options.role ?? "containerMcp"}:frame`, "body"), () => []);
  let issued = false, verdicts = 0, upstreams = 0, envelopes = 0, stderrBytes = 0;
  let httpStarted = 0, httpBodies = 0, httpDenied = 0, stdoutBytes = 0, acknowledgements = 0, terminals = 0;
  let phase = 0, operationFailed = false;
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    httpStarted++;
    if (ownerDoor) {
      issued = true; verdicts++;
      const json = (out: typeof res, status: number, body: unknown) => { out.writeHead(status, { "content-type": "application/json" }); out.end(JSON.stringify(body)); };
      return void ownerDoor(req, res, { capabilities: caps, authority, json });
    }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new Error("limit"); chunks.push(chunk); }
      httpBodies++;
      const claim = caps.resolve(req.headers.authorization);
      if (!claim) throw new Error("authority");
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const late = (ms: number | undefined, first: boolean) => first && ms ? new Promise<void>(done => setTimeout(done, ms)) : undefined;
      if (body?.operation === "upstream") { await late(options.slowUpstreamMs, upstreams++ === 0); authority.reserveUpstream(claim, body); res.end(JSON.stringify({ reserved: true })); return; }
      await late(options.slowVerdictMs, verdicts === 0 && !issued);
      const envelope = authority.verdict(claim, body);
      issued = true; verdicts++; res.end(JSON.stringify(envelope));
    } catch { httpDenied++; instance.ingress.seal(); res.writeHead(409).end(); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe", "ipc"], env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
      HOME: isolatedHome, USERPROFILE: isolatedHome, APPDATA: isolatedHome, LOCALAPPDATA: isolatedHome,
      TMPDIR: isolatedHome, TMP: isolatedHome, TEMP: isolatedHome, NODE_ENV: "test", ELECTRON_RUN_AS_NODE: "1",
      MURAGE_DATA_DIR: isolatedHome,
      MURAGE_CONTROL_URL: "", MURAGE_CONTROL_TOKEN: "", ...options.env, MURAGE_RELEASE_INSTANCE: instance.instanceId,
      MURAGE_RELEASE_TOKEN: instance.token, MURAGE_RELEASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
  });
  const output: string[] = []; let pending = "", entryReady = false, raceReached = false;
  let replacement: ReturnType<typeof consumingFixture> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const counts = () => `role=${options.role ?? "containerMcp"} phase=${phase} ready=${Number(entryReady)} requests=${requests.length} httpStarted=${httpStarted} httpBodies=${httpBodies} httpDenied=${httpDenied} verdicts=${verdicts} stdoutBytes=${stdoutBytes} pendingBytes=${Buffer.byteLength(pending)} envelopes=${envelopes} accepted=${output.length} acknowledgements=${acknowledgements} terminals=${terminals} stderrBytes=${stderrBytes} sealed=${Number(instance.ingress.sealed)} refusals=${fixture.refusals} exited=${Number(child.exitCode !== null || child.signalCode !== null)} sockets=${sockets.size}`;
  const diagnostic = (reason: string) => new Error(`${reason}: ${counts()}`);
  try {
    phase = 1;
    return await new Promise<string[]>((resolve, reject) => {
      timer = setTimeout(() => reject(diagnostic("bound fixture timeout")), (options.timeoutMs ?? 8000) + (options.slowVerdictMs ?? 0) + (options.slowUpstreamMs ?? 0));
      instance.ingress.supervise(child);
      child.stderr!.on("data", chunk => { stderrBytes += chunk.length; });
      child.on("error", reject);
      child.stdin!.on("error", error => { instance.ingress.seal(); reject(error); });
      child.stdout!.on("error", error => { instance.ingress.seal(); reject(error); });
      const raced = options.flipBeforeDelivery || options.race;
      const raceAt = options.raceAtSequence ?? 1;
      const beforeRace = raceAt - 1;
      const terminal = () => entryReady && count === 0 && !raced && instance.ingress.sealed && fixture.refusals === 1 && output.length === 0;
      child.on("close", () => terminal() ? resolve(output) : reject(diagnostic("premature fixture close")));
      child.on("message", message => {
        try {
          if ((message as { type?: string })?.type === "fixture-entry-failed") {
            const failure = message as Record<string, unknown>;
            const count = (name: string) => Number.isSafeInteger(failure[name]) ? Number(failure[name]) : 0;
            reject(diagnostic(`fixture entry importFailures=${count("importFailures")} importCode=${count("importCode")} syntaxFailures=${count("syntaxFailures")} referenceFailures=${count("referenceFailures")}`));
            return;
          }
          if ((message as { type?: string })?.type === "fixture-entry-ready") {
            expect(entryReady).toBe(false); entryReady = true;
            if (!options.delays && !options.raw) {
              for (const request of requests) instance.ingress.request(request, () => { child.stdin!.write(request + "\n"); });
              if (eof) child.stdin!.end();
              return;
            }
            void (async () => {
              for (const [index, request] of requests.entries()) {
                const wait = options.delays?.[index] ?? 0;
                if (wait) await new Promise<void>(done => setTimeout(done, wait));
                if (options.raw?.includes(index)) {
                  // the relay saw a call with this id; the bytes on the child's pipe are the whole oversized line
                  const { id, method } = JSON.parse(request) as { id: unknown; method: string };
                  instance.ingress.request(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }), () => { child.stdin!.write(request + "\n"); });
                } else instance.ingress.request(request, () => { child.stdin!.write(request + "\n"); });
              }
              if (eof) child.stdin!.end();
            })().catch(error => { instance.ingress.seal(); reject(error); });
            return;
          }
          expect(message).toMatchObject({ type: "turn-release-terminal", instanceId: instance.instanceId,
            frame: { error: { code: -32099, data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true } } } });
          terminals++;
          instance.ingress.seal(); terminal() ? resolve(output) : reject(diagnostic("unexpected fixture refusal"));
        } catch (error) { instance.ingress.seal(); reject(error); }
      });
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", chunk => {
        stdoutBytes += Buffer.byteLength(chunk);
        try {
          pending += chunk;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const envelope = decodeReleaseEnvelope(pending.slice(0, newline), options.owner === true); pending = pending.slice(newline + 1);
            envelopes++;
            const applyRace = envelope.sequence === raceAt;
            if (applyRace && raced) raceReached = true;
            if (applyRace && (options.race === "drain" || options.race === "transport")) {
              // Exercise the production asynchronous capacity boundary. The
              // permit exists, but the destination has not accepted any bytes.
              void instance.ingress.accept(envelope, {
                capacity: async () => {
                  if (options.race === "transport") {
                    await new Promise<void>(done => { child.once("disconnect", done); child.disconnect(); });
                  } else { await Promise.resolve(); fixture.flip(); }
                },
                write: frame => output.push(frame),
              }).then(() => reject(new Error("revoked capacity wait accepted output")), error => {
                if (raceReached && error instanceof Error && error.message === "MEMORY_CONTEXT_REVOKED"
                  && issued && instance.ingress.sealed && fixture.refusals === 1 && output.length === beforeRace) resolve(output);
                else reject(error);
              });
              continue;
            }
            if (applyRace && options.flipBeforeDelivery) fixture.flip();
            if (applyRace && options.race === "replacement") {
              fixture.replace();
              replacement = consumingFixture(undefined, { empty: true });
            }
            instance.ingress.deliver(envelope, frame => output.push(frame));
            child.send({ type: "turn-release-ack", instanceId: instance.instanceId, sequence: envelope.sequence }, error => {
              if (error) { instance.ingress.seal(); reject(diagnostic("fixture acknowledgement failed")); }
              else {
                acknowledgements++;
                // Teardown must not disconnect IPC while the final accepted
                // frame's acknowledgement is still queued in the parent.
                if (output.length === count && (!raced || envelope.sequence >= raceAt)) resolve(output);
              }
            });
          }
        } catch (error) {
          instance.ingress.seal();
          if (raced && raceReached && error instanceof Error && error.message === "MEMORY_CONTEXT_REVOKED"
            && issued && instance.ingress.sealed && fixture.refusals === 1 && output.length === beforeRace
            && (!replacement || replacement.refusals === 0 && replacement.binding.isCurrent() && replacement.turn.parents.length === 0)) resolve(output);
          else reject(error);
        }
      });
    });
  } catch (error) {
    // Preserve the first operation failure even if teardown fails afterwards.
    // Never include the child stderr, frame, capability or response body.
    operationFailed = true;
    console.warn(`bound-proxy failures=1 ${counts()}`);
    throw error;
  } finally {
    phase = 2;
    if (timer) clearTimeout(timer);
    instance.dispose();
    if (child.connected) child.disconnect();
    try {
      await stopBoundChild(child);
    } catch {
      // Do not let a child-close wait replace the original failure with an
      // unclassified timeout (or copy a process identifier into lane logs).
      console.warn(`bound-proxy failures=1 ${counts()}`);
      if (!operationFailed) throw diagnostic("fixture child shutdown");
    } finally {
      phase = 3;
      // Stop accepting first, then destroy every owned socket, including a
      // connection accepted before HTTP registered it as an active request.
      // The old fixture could wait forever after its 8 s operation deadline.
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(diagnostic("fixture shutdown")), 1000);
        server.close(error => { clearTimeout(deadline); error ? reject(error) : resolve(); });
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      }).finally(() => { replacement?.close(); fixture.close(); removeTempDirSync(isolatedHome); });
    }
  }
}

// control: preserve legacy interactive fixture assertions while replacing raw
// engine stdout with the real server-owned final ingress. No release mock.
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
const boundStates = new WeakMap<object, () => { sealed: boolean; refusals: number; terminal?: unknown }>();
const boundTerminals = new WeakMap<object, () => unknown>();
const boundTerminalReasons = new WeakMap<object, () => unknown>();
/** The code word a terminal notice named for its first refusing check (undefined before one arrived). */
export function boundTerminalReason(child: object): unknown { return boundTerminalReasons.get(child)?.(); }
export function boundProxyState(child: object) {
  const state = boundStates.get(child);
  if (!state) throw new Error("fixture child was not admitted");
  return state();
}
/** Authenticated supervisor receipt, separate from the existing state shape. */
export function boundProxyTerminal(child: object): unknown {
  if (!boundStates.has(child)) throw new Error("fixture child was not admitted");
  return boundTerminals.get(child)?.();
}
export async function spawnBoundProxy(role: string, command: string, args: readonly string[],
  options: SpawnOptions & { fixtureLifetime?: "test" | "suite";
    /** The release door drops the connection of the first N upstream reservations that carry bytes (it answers nothing; nothing is reserved). */
    dropUpstreams?: number;
    /** Asked for every door call that carries bytes, in arrival order: true drops its connection the same way (nothing is answered,
     * nothing is issued or reserved). `verdicts` counts the verdict calls the door has answered so far. */
    dropDoor?: (call: { kind: "verdict" | "reserve"; verdicts: number }) => boolean } = {}): Promise<ChildProcessWithoutNullStreams> {
  const { fixtureLifetime = "test", dropUpstreams = 0, dropDoor, ...spawnOptions } = options;
  let droppedUpstreams = 0, answeredVerdicts = 0;
  if (!hasIngress) {
    const child = spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams;
    boundStates.set(child, () => ({ sealed: false, refusals: 0 }));
    return child;
  }
  const fixture = consumingFixture(), caps = new InternalCapabilities();
  caps.begin("B", "T", fixture.binding.identity.dispatchGeneration);
  const home = mkdtempSync(join(tmpdir(), "murage-interactive-proxy-"));
  const authority = createProxyReleaseAuthority(caps);
  const instance = authority.register(fixture.binding, registerConsumingDescriptor(`proxy:${role}:frame`, "body"), () => []);
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error("limit"); chunks.push(chunk); }
      const claim = caps.resolve(req.headers.authorization);
      if (!claim) throw new Error("authority");
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body?.operation === "upstream" && Number(body.bytes) > 0 && droppedUpstreams < dropUpstreams) { droppedUpstreams++; req.socket.destroy(); return; }
      if ((body?.operation !== "upstream" || Number(body.bytes) > 0) && dropDoor?.({ kind: body?.operation === "upstream" ? "reserve" : "verdict", verdicts: answeredVerdicts })) { req.socket.destroy(); return; }
      if (body?.operation === "upstream") { authority.reserveUpstream(claim, body); res.end(JSON.stringify({ reserved: true })); return; }
      const envelope = authority.verdict(claim, body);
      answeredVerdicts++; res.end(JSON.stringify(envelope));
    } catch { instance.ingress.seal(); res.writeHead(409).end(); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(command, [...args], { ...spawnOptions, stdio: ["pipe", "pipe", "pipe", "ipc"], env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ...options.env,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, MURAGE_DATA_DIR: home,
    TMPDIR: home, TMP: home, TEMP: home, NODE_ENV: "test", ELECTRON_RUN_AS_NODE: "1",
    MURAGE_RELEASE_INSTANCE: instance.instanceId, MURAGE_RELEASE_TOKEN: instance.token,
    MURAGE_RELEASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  } }) as ChildProcessWithoutNullStreams;
  const input = child.stdin, output = child.stdout, accepted = new PassThrough();
  const requestDecoder = new StringDecoder("utf8");
  let requestBuffer = "", frameBuffer = "";
  const engineInput = new Writable({
    write(chunk, _encoding, done) {
      try {
        requestBuffer += requestDecoder.write(chunk);
        if (Buffer.byteLength(requestBuffer) > 16 * 1024 * 1024) throw new Error("limit");
        let newline: number;
        while ((newline = requestBuffer.indexOf("\n")) >= 0) {
          const frame = requestBuffer.slice(0, newline); requestBuffer = requestBuffer.slice(newline + 1);
          instance.ingress.request(frame, () => { input.write(frame + "\n"); });
        }
        done();
      } catch (error) { instance.ingress.seal(); done(error as Error); }
    },
    final(done) { requestBuffer += requestDecoder.end(); if (requestBuffer.trim()) { instance.ingress.seal(); done(new Error("incomplete fixture request")); } else { input.end(); done(); } },
  });
  Object.defineProperty(child, "stdin", { value: engineInput });
  Object.defineProperty(child, "stdout", { value: accepted });
  let terminal: unknown;
  let terminalReason: unknown;
  let terminalExit: ReturnType<typeof setTimeout> | undefined;
  boundStates.set(child, () => ({ sealed: instance.ingress.sealed, refusals: fixture.refusals, ...(terminal ? { terminal } : {}) }));
  boundTerminals.set(child, () => terminal);
  boundTerminalReasons.set(child, () => terminalReason);
  engineInput.on("error", () => { instance.ingress.seal(); child.kill(); });
  instance.ingress.supervise(child);
  output.setEncoding("utf8").on("data", chunk => {
    try {
      frameBuffer += chunk;
      if (Buffer.byteLength(frameBuffer) > 16 * 1024 * 1024) throw new Error("limit");
      let newline: number;
      while ((newline = frameBuffer.indexOf("\n")) >= 0) {
        const envelope = decodeReleaseEnvelope(frameBuffer.slice(0, newline)); frameBuffer = frameBuffer.slice(newline + 1);
        instance.ingress.deliver(envelope, frame => { accepted.write(frame + "\n"); });
        child.send({ type: "turn-release-ack", instanceId: instance.instanceId, sequence: envelope.sequence });
      }
    } catch { instance.ingress.seal(); child.kill(); }
  });
  // The facade has the same EOF as the actual transport. Waiting for all
  // child stdio/IPC cleanup can leave an engine reader waiting after stdout ended.
  output.once("end", () => { accepted.end(); });
  child.on("message", message => {
    instance.ingress.seal();
    const notice = message as { type?: string; instanceId?: string; frame?: { error?: { code?: number; data?: { code?: string; terminal?: boolean } } } };
    if (notice?.type !== "turn-release-terminal" || notice.instanceId !== instance.instanceId
      || notice.frame?.error?.code !== -32099 || notice.frame.error.data?.code !== "MEMORY_CONTEXT_REVOKED"
      || notice.frame.error.data.terminal !== true || terminal) { child.kill(); return; }
    terminal = notice.frame; terminalReason = (message as { reason?: unknown }).reason;
    // A valid terminal notice already sealed final ingress. Let the exact
    // child flush its close and exit code; still bound its process lifetime.
    terminalExit = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 1000);
    terminalExit.unref();
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    if (terminalExit) clearTimeout(terminalExit);
    unregister(); instance.dispose();
    try {
      await stopBoundChild(child);
    } finally {
      accepted.end();
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`fixture shutdown sockets=${sockets.size}`)), 1000);
        server.close(error => { clearTimeout(deadline); error ? reject(error) : resolve(); });
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      }).finally(() => { fixture.close(); removeTempDirSync(home); });
    }
  })();
  // The registry is shared across dynamic imports and awaited by the existing
  // isolated-test setup. Registering a Vitest hook here is illegal when this
  // helper is first imported inside an actual-entry test.
  // A beforeAll-owned child must remain bound across its suite's controls.
  // The owning afterAll kills it and its close event releases this fixture.
  // Global per-test settlement must not terminate that shared generation.
  const unregister = registerTestHandle("stop", dir =>
    (fixtureLifetime !== "suite" || dir !== undefined) && pathIsWithin(home, dir) ? close() : undefined);
  child.once("close", () => { void close(); });
  return child;
}
