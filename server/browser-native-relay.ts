// Harness-owned transport for pinned agent-browser 0.36.0. Its raw localhost
// stream has NO authentication: this relay protects network clients, not other
// processes running with the same OS identity. Never disclose its port in APIs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { ensureBrowserSandboxAccess } from "./browser-sandbox.ts";
import { BrowserDocumentGuard } from "./browser-document-guard.ts";
import type { AgentBrowserSpec } from "./browser-engine.ts";
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";

export type BrowserFrame = { seq: number; data: string; width: number; height: number };
export interface NativeBrowser {
  protected(armed?: boolean): Promise<boolean>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  command(args: string[]): Promise<unknown>;
  connect(onFrame: (frame: BrowserFrame) => void, onUrl: (url: string) => void, onDisconnect: () => void): Promise<string>;
  input(event: Record<string, unknown>): void;
  resetStream(): void;
  close(): Promise<void>;
}
export function createNativeBrowser(spec: AgentBrowserSpec): NativeBrowser {
  let client: EngineClient | undefined;
  let socket: WebSocket | undefined;
  let initialized: Promise<void> | undefined;
  let closing = false;
  let streamId = "";
  let daemonPid: number | undefined;
  const pidFile = join(spec.env.AGENT_BROWSER_SOCKET_DIR!, `${spec.env.AGENT_BROWSER_SESSION}.pid`);
  const command = async (args: string[]): Promise<unknown> => { await ensureBrowserSandboxAccess(spec); return new Promise((resolve, reject) => {
    const child = spawn(spec.command, ["--json", ...args], { env: spec.env, cwd: spec.env.HOME, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let overflow = false;
    const timer = setTimeout(() => { overflow = true; child.kill("SIGKILL"); }, 20_000);
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 2_000_000) { overflow = true; child.kill("SIGKILL"); }
      else output += chunk.toString();
    });
    child.once("error", () => { clearTimeout(timer); reject(new Error("Browser command could not start")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || overflow) return reject(new Error("Browser command failed or exceeded its bound"));
      try { const value = JSON.parse(output); if (value.success === false) throw new Error(); try { daemonPid = Number(readFileSync(pidFile, "utf8")); } catch {} resolve(value.data ?? value); }
      catch { reject(new Error("Browser returned an invalid command result")); }
    });
  });
  };
  const guard = new BrowserDocumentGuard(command);
  return {
    command,
    protected: (armed = true) => guard.protected(armed),
    async request(method, params) {
      await ensureBrowserSandboxAccess(spec);
      if (!initialized) {
        client = startHeadlessEngine(spec);
        initialized = client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "murage-browser", version: "1" } }).then(() => {});
      }
      await initialized;
      return client!.request(method, params);
    },
    async connect(onFrame, onUrl, onDisconnect) {
      closing = false;
      if (socket?.readyState === WebSocket.OPEN) return streamId;
      const result = await command(["stream", "status"]) as { port?: number; streamPort?: number };
      const port = result.port ?? result.streamPort;
      if (!Number.isInteger(port) || port! < 1 || port! > 65535) throw new Error("Browser returned an invalid stream port");
      streamId = String(port);
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=10`, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 5000 });
        socket = ws;
        ws.once("open", resolve);
        ws.on("error", () => reject(new Error("Browser stream unavailable")));
        ws.on("close", () => { if (socket === ws) socket = undefined; if (!closing) onDisconnect(); });
        ws.on("message", (raw) => {
          try {
            const value = JSON.parse(raw.toString());
            if (value.type === "frame" && typeof value.data === "string" && value.data.length <= 3_000_000 && Number.isSafeInteger(value.seq)) {
              onFrame({ seq: value.seq, data: value.data, width: value.metadata?.deviceWidth ?? 1280, height: value.metadata?.deviceHeight ?? 800 });
              ws.send(JSON.stringify({ type: "ack", seq: value.seq }));
            } else if (value.type === "url" && typeof value.url === "string") onUrl(value.url.slice(0, 8192));
          } catch { ws.close(1008); }
        });
      });
      return streamId;
    },
    input(event) {
      if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) throw new Error("Browser stream disconnected or busy");
      socket.send(JSON.stringify(event));
    },
    resetStream() { const old = socket; socket = undefined; old?.removeAllListeners(); old?.terminate(); },
    async close() {
      closing = true;
      guard.close();
      socket?.close(); socket = undefined;
      await client?.close();
      await command(["close"]);
      const pid = daemonPid;
      if (pid && Number(readFileSync(pidFile, "utf8")) === pid) {
        if (process.platform === "win32") {
          const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
          const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){if($p.Path -ne ${quote(spec.command)}){throw 'Browser daemon identity changed'}; Stop-Process -Id ${pid}; Wait-Process -Id ${pid} -Timeout 5 -ErrorAction SilentlyContinue}`;
          await new Promise<void>((done, fail) => {
            const cleanup = spawn(join(spec.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore" });
            const timer = setTimeout(() => cleanup.kill(), 7000);
            cleanup.once("error", () => { clearTimeout(timer); fail(new Error("Browser daemon cleanup could not start")); });
            cleanup.once("exit", code => { clearTimeout(timer); code === 0 ? done() : fail(new Error("Browser daemon cleanup failed")); });
          });
        } else {
          // The daemon PID is read back from this controller's private runtime
          // directory after a successful command, never supplied by a caller.
          try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      }
      daemonPid = undefined; client = undefined; initialized = undefined;

    },
  };
}
