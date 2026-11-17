// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The probe helper (design V4): one proof attempt in its own child process, so a stuck read or a stuck native call can be ended with
// SIGKILL without touching the server. stdin: one request as JSON (mcp-stop-helper.ts HelperRequest; a bare StopRecord is a "prove"). stdout:
// one answer as JSON. It signals nothing and writes nothing. Every enumeration of the stop path runs here (nlrace finding 4).
import { runHelperRequest } from "./mcp-stop-target.ts";

import { WARM_HELPER_ENV } from "./mcp-stop-helper.ts";

if (process.env[WARM_HELPER_ENV] === "1") serveWarm(); else serveOne();

/** R8-C warm mode: requests one per line, answered one per line in arrival order, until stdin ends (its relay is gone): then it exits. */
function serveWarm(): void {
  let buffered = "";
  let chain: Promise<void> = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    if (buffered.length > 1_000_000) process.exit(0);
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
      chain = chain.then(async () => {
        let id: unknown = null;
        try {
          const message = JSON.parse(line) as { id?: unknown; request?: unknown };
          id = message.id;
          process.stdout.write(`${JSON.stringify({ id, answer: await runHelperRequest(message.request) })}\n`);
        } catch {
          process.stdout.write(`${JSON.stringify({ id, answer: null })}\n`);
        }
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
}

function serveOne(): void {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => { if (input.length < 1_000_000) input += chunk; });
  process.stdin.on("end", () => {
    void (async () => {
      try {
        process.stdout.write(`${JSON.stringify(await runHelperRequest(JSON.parse(input) as unknown))}\n`);
      } catch {
        process.stdout.write(`${JSON.stringify({ v: "unknown", why: "the probe helper could not read its record" })}\n`);
      }
      process.exit(0);
    })();
  });
}
