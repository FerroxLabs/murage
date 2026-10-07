// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feedLaunchSecretStdin, launchSecretVia, sendLaunchSecretParent } from "../electron/launch-secret.mjs";
import { takeLaunchSecret } from "./launch-secret.ts";
import { takeLaunchSecret as takeCompanionLaunchSecret } from "../companion/src/launch-secret.ts";

const SECRET = "d".repeat(64);
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
const tempTokenFolders = () => readdirSync(tmpdir()).filter((name) => name.startsWith("murage-ls-"));

describe("launch secret handoff over a private pipe (audit P1, S1b R8)", () => {
  for (const [label, take] of [["server", takeLaunchSecret], ["companion", takeCompanionLaunchSecret]] as const) {
    it(`${label}: reads the secret once from stdin and leaves nothing in the environment`, async () => {
      const before = tempTokenFolders();
      const stdin = new PassThrough();
      const env: NodeJS.ProcessEnv = { MURAGE_X_VIA: "stdin", MURAGE_X: "ambient", MURAGE_X_FILE: "/attacker/file", KEEP: "1" };
      const pending = take("MURAGE_X", env, { stdin });
      stdin.end(`${SECRET}\n`);
      expect(await pending).toBe(SECRET);
      expect(env).toEqual({ KEEP: "1" });
      expect(tempTokenFolders()).toEqual(before);
    });

    it(`${label}: reads the secret from the utility parent port and ignores other messages`, async () => {
      const port = new EventEmitter() as EventEmitter & { on(event: "message", l: (e: { data?: unknown }) => void): never };
      const env: NodeJS.ProcessEnv = { MURAGE_X_VIA: "parent" };
      const pending = take("MURAGE_X", env, { parentPort: port as never });
      port.emit("message", { data: { type: "murage:launch-secret", name: "MURAGE_OTHER", value: "no" } });
      port.emit("message", { data: { type: "other", name: "MURAGE_X", value: "no" } });
      port.emit("message", { data: { type: "murage:launch-secret", name: "MURAGE_X", value: SECRET } });
      expect(await pending).toBe(SECRET);
      expect(env).toEqual({});
    });

    it(`${label}: a parent that never delivers leaves no secret, and a leftover file is never followed`, async () => {
      const stdin = new PassThrough();
      expect(await take("MURAGE_X", { MURAGE_X_VIA: "stdin", MURAGE_X: "ambient" }, { stdin, waitMs: 20 })).toBeUndefined();
      expect(await take("MURAGE_X", { MURAGE_X_VIA: "parent" }, { waitMs: 20 })).toBeUndefined();
      expect(await take("MURAGE_X", { MURAGE_X_FILE: "/some/file" })).toBeUndefined();
    });

    it(`${label}: still takes a plain variable for a development launch, and removes it`, async () => {
      const env: NodeJS.ProcessEnv = { MURAGE_X: SECRET };
      expect(await take("MURAGE_X", env)).toBe(SECRET);
      expect(env.MURAGE_X).toBeUndefined();
    });
  }

  it("parent messages that arrive before the real handler are held and replayed once, in order", async () => {
    // A fresh module: the held messages are process-wide state.
    vi.resetModules();
    const fresh = await import("./launch-secret.ts");
    const { replayEarlyParentMessages } = fresh;
    const port = new EventEmitter();
    const env: NodeJS.ProcessEnv = { MURAGE_X_VIA: "parent" };
    const pending = fresh.takeLaunchSecret("MURAGE_X", env, { parentPort: port as never });
    port.emit("message", { data: { type: "murage:browser-connection", n: 1 } });
    port.emit("message", { data: { type: "murage:launch-secret", name: "MURAGE_X", value: SECRET } });
    port.emit("message", { data: { type: "murage:model-sign-in", n: 2 } });
    expect(await pending).toBe(SECRET);
    const replayed: unknown[] = [];
    replayEarlyParentMessages((event) => replayed.push(event.data));
    expect(replayed).toEqual([{ type: "murage:browser-connection", n: 1 }, { type: "murage:model-sign-in", n: 2 }]);
    // the secret itself is never replayed, and nothing is held after release
    port.emit("message", { data: { type: "late" } });
    const again: unknown[] = [];
    replayEarlyParentMessages((event) => again.push(event.data));
    expect(again).toEqual([]);
  });

  it("the writers carry the value and name only the transport in the environment", () => {
    expect(launchSecretVia("MURAGE_X", "stdin")).toEqual({ MURAGE_X_VIA: "stdin" });
    expect(() => launchSecretVia("MURAGE_X", "file" as never)).toThrow();
    const sent: unknown[] = [];
    sendLaunchSecretParent({ postMessage: (m) => sent.push(m) }, "MURAGE_X", SECRET);
    expect(sent).toEqual([{ type: "murage:launch-secret", name: "MURAGE_X", value: SECRET }]);
    expect(() => feedLaunchSecretStdin({ stdin: null }, SECRET)).toThrow();
  });

  it("a real spawned child gets the secret on stdin and creates no token file", async () => {
    const before = tempTokenFolders();
    const script = `
      const { takeLaunchSecret } = await import(${JSON.stringify(new URL("./launch-secret.ts", import.meta.url).href)});
      const got = await takeLaunchSecret("MURAGE_X");
      process.stdout.write("ready:" + (got === "d".repeat(64)) + "\\n");
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { PATH: process.env.PATH, ...launchSecretVia("MURAGE_X", "stdin") },
      stdio: ["pipe", "pipe", "ignore"],
    });
    cleanups.push(() => child.kill("SIGKILL"));
    feedLaunchSecretStdin(child, SECRET);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", (chunk) => (String(chunk).includes("ready:true") ? resolve() : reject(new Error(String(chunk)))));
      child.once("error", reject);
    });
    expect(tempTokenFolders()).toEqual(before);
    if (process.platform === "linux") {
      // Nothing a same-user process can read from /proc/<pid>.
      expect(readFileSync(`/proc/${child.pid}/environ`, "utf8")).not.toContain(SECRET);
      expect(readFileSync(`/proc/${child.pid}/environ`, "utf8")).toContain("MURAGE_X_VIA=stdin");
      expect(readFileSync(`/proc/${child.pid}/cmdline`, "utf8")).not.toContain(SECRET);
    }
  });
});
