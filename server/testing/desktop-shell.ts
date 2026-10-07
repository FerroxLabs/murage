// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The harness the way the desktop app runs it, without Electron: node
// server/index.ts with Electron's private parent port (fed over an IPC channel,
// as main.mjs feeds the utility process), and main's own MCP service
// (electron/mcp-signin/service.mjs, the object main.mjs builds) over an
// in-memory stand-in for credentials.bin. The browser is the fake one: the
// authorize URL is fetched without following the redirect, and the loopback
// callback is called by hand (fakeBrowserApprove).
//
// So the server has a desktop shell (oauth-target answers, bodies never carry a
// secret), and main does exactly what it does in the app: it writes to the
// store first, then pushes over the commit route; it hears
// `murage:mcp-token-rejected` and `murage:mcp-secrets-stale`; and on every
// start it hands the server MURAGE_MCP_SERVER_SECRETS and then pushes every
// saved doc (resume). The credential document lives in this process only, so a
// grep of the run's temp directory must find no token at all.
//
// Used by server/mcp-link.e2e.test.ts and src/e2e/mcp-link.human.spec.ts.
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { waitForExit } from "./cleanup.ts";
import { fakeBrowserApprove } from "./fake-remote-mcp.ts";
import { freePortBlock } from "./ports.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(SERVER_DIR, "..");

type McpResult = { ok: true; revoked?: boolean | null; message?: string } | { ok: false; error: string; message: string };
/** The parts of main's MCP service (electron/mcp-signin/service.mjs) a test drives. */
export interface McpService {
  saveSecrets(name: string, input: { headers?: Record<string, string>; url?: string; env?: Record<string, string> }): Promise<McpResult>;
  signIn(name: string): Promise<McpResult>;
  cancelSignIn(name: string): boolean;
  signOut(name: string): Promise<McpResult>;
  remove(name: string): Promise<McpResult>;
  resume(options?: { now?: number }): Promise<void>;
  refresh(name: string, options?: { reactive?: boolean }): Promise<boolean>;
  handleTokenRejected(name: unknown): Promise<boolean>;
  handleSecretsStale(message: unknown): Promise<boolean>;
  dispose(): void;
}
interface CredentialState { read(): Record<string, unknown>; update(derive: (current: Record<string, unknown>) => unknown): Promise<unknown> }
/** Main's own modules, loaded as main loads them (plain .mjs, no declarations). */
const electron = (path: string): Promise<any> => import(pathToFileURL(join(ROOT, "electron", path)).href);

/** Electron's private utility-process port, one listener, fed from the IPC channel. */
const PARENT_PORT_PRELUDE = `data:text/javascript,${encodeURIComponent(`
  let listener;
  process.on("message", (data) => listener?.({ data }));
  Object.defineProperty(process, "parentPort", { value: {
    on(event, callback) { if (event === "message") listener = callback; },
    postMessage(message) { process.send?.(message); },
  } });
`)}`;

export const SHELL_MCP_COMMIT_TOKEN = "a1b2c3d4e5f60718".repeat(4);

type Answer = { status: number; body: any };

export interface DesktopShellOptions {
  home: string;
  /** Extra environment for the harness (engine fakes read their switches from instance environments instead). */
  env?: Record<string, string>;
}

export interface DesktopShell {
  readonly base: string;
  readonly port: number;
  /** The desktop proof, as the renderer sends it. */
  headers(): Record<string, string>;
  desktop(method: string, path: string, body?: unknown): Promise<Answer>;
  /** What main's commit routes send: the desktop proof plus the MCP commit token. */
  commit(method: string, path: string, body?: unknown): Promise<Answer>;
  /** Main's MCP service: saveSecrets, signIn, cancelSignIn, signOut, remove, resume. */
  readonly service: McpService;
  /** The in-memory credentials.bin. */
  credentials(): Record<string, unknown>;
  /** Every private message the harness posted to main, in order. */
  readonly privateMessages: Array<Record<string, unknown>>;
  /** Every authorize URL main opened in the "browser". */
  readonly opened: string[];
  readonly log: string[];
  stderr(): string;
  /** Stop the harness and start it again the way the app relaunches it. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export async function startDesktopShell(options: DesktopShellOptions): Promise<DesktopShell> {
  const { createMcpServers } = await electron("mcp-signin/service.mjs");
  const { createSecureCredentialState } = await electron("secure-credential-state.mjs");
  const { workspaceCredentialEnv } = await electron("workspace-credentials.mjs");
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let secret = "";
  let stderr = "";
  const privateMessages: Array<Record<string, unknown>> = [];
  const opened: string[] = [];
  const log: string[] = [];
  let saved: Record<string, unknown> = {};
  const state: CredentialState = createSecureCredentialState(saved, async (next: Record<string, unknown>) => { saved = structuredClone(next); });

  const request = async (method: string, path: string, body: unknown, extra: Record<string, string>): Promise<Answer> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const commit = (method: string, path: string, body?: unknown) => request(method, path, body, { authorization: `Bearer ${SHELL_MCP_COMMIT_TOKEN}` });

  const service: McpService = createMcpServers({
    readDocument: () => state.read(),
    updateDocument: (derive: (current: Record<string, unknown>) => unknown) => state.update(derive),
    commit: (route: string, init: { method?: string; body?: unknown } = {}) => commit(init.method ?? "GET", route, init.body),
    openExternal: async (url: string) => {
      opened.push(url);
      const approved = await fakeBrowserApprove(url);
      if (approved.redirectUrl) await fetch(approved.redirectUrl).then((response) => response.text()).catch(() => "");
    },
    createServer: () => http.createServer(),
    platform: "darwin",
    env: { DISPLAY: ":0" },
    log: (line: string) => log.push(line),
    // The refresher's own timers never fire in a test: refreshes happen on a
    // rejected token (reactive) or at resume, as the steps drive them.
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });

  const onMessage = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const frame = message as Record<string, unknown>;
    if (frame.type === "murage:desktop-secret" && typeof frame.secret === "string") {
      secret = frame.secret;
      return;
    }
    privateMessages.push(structuredClone(frame));
    if (frame.type === "murage:mcp-token-rejected") void service.handleTokenRejected(frame.name);
    if (frame.type === "murage:mcp-secrets-stale") void service.handleSecretsStale(frame);
  };

  const start = async () => {
    stderr = "";
    secret = "";
    const boot = workspaceCredentialEnv(state.read()) as Record<string, string>;
    child = spawn(process.execPath, ["--import", PARENT_PORT_PRELUDE, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: options.home,
        USERPROFILE: options.home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_MCP_COMMIT_TOKEN: SHELL_MCP_COMMIT_TOKEN,
        ...(boot.MURAGE_MCP_SERVER_SECRETS ? { MURAGE_MCP_SERVER_SECRETS: boot.MURAGE_MCP_SERVER_SECRETS } : {}),
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("message", onMessage);
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`harness exited ${child.exitCode}. stderr:\n${stderr}`);
      try { if ((await fetch(`${base}/api/health`)).ok && secret) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`harness never came up. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // main.mjs after the harness is up: every saved doc, then refresh or schedule.
    await service.resume();
  };

  const stop = async () => {
    const running = child;
    child = undefined;
    if (running && running.exitCode === null) await waitForExit(running, { signal: "SIGTERM" });
  };

  await start();
  return {
    base, port,
    headers: () => ({ "x-murage-surface": "desktop", "x-murage-surface-secret": secret }),
    desktop: (method, path, body) => request(method, path, body, {}),
    commit,
    service,
    credentials: () => state.read(),
    privateMessages, opened, log,
    stderr: () => stderr,
    restart: async () => { await stop(); await start(); },
    stop: async () => { service.dispose(); await stop(); },
  };
}
