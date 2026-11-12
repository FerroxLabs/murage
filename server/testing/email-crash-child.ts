// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park crash harness child (server/email/restore-park-crash.test.ts, r3.1 section 10 C1-C14): opens the test's data dir (db.sqlite, secrets.json), boots the
// real EmailRuntime against a scripted fake Flux, runs one owner act, and kills itself with SIGKILL at the named checkpoint (EmailRuntime option `checkpoint`,
// a no-op in production). Every Flux request is appended to calls.log before it is answered, so the parent sees what this process sent.
// Usage: email-crash-child.ts <scenario: keep|remove|orphan-keep|orphan-remove> <checkpoint>
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EmailRuntime } from "../email/runtime.ts";
import { FakeFlux, fluxError } from "./fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const [scenario = "", at = ""] = process.argv.slice(2);
const dir = process.env.EMAIL_CRASH_DIR;
if (!dir || !process.env.EMAIL_CRASH_CHILD) { process.stderr.write("refusing: not started by the restore park crash test\n"); process.exit(2); }

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
const fake = new FakeFlux();
fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
fake.always("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing" } });
fake.always("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active" } });
fake.always("DELETE", /\/inboxes\/ibx_1$/, scenario === "remove" && at === "C9" ? fluxError(404, "inbox_not_found") : { status: 202, body: { state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
fake.always("DELETE", /bot-keys\/key_old$/, { status: 204 });
const logged = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  appendFileSync(join(dir, "calls.log"), `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}\n`);
  return fake.fetch(input, init);
}) as typeof fetch;

const orphan = scenario.startsWith("orphan-keep");
const db = new DatabaseSync(join(dir, "db.sqlite"));
const runtime = new EmailRuntime({
  accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: logged, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
  now: () => Number(process.env.EMAIL_CRASH_NOW), workspaceRoot: () => undefined,
  bot: id => (orphan ? undefined : ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord)), deletionProof: () => true,
  persistSecrets: doc => writeFileSync(join(dir, "secrets.json"), JSON.stringify(doc)),
  checkpoint: name => { if (name === at) { process.kill(process.pid, "SIGKILL"); for (;;) { /* the signal is on its way */ } } },
});
runtime.secrets.replaceAll(JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")));
await runtime.probe.refresh();
await runtime.start();
runtime.stop();
const bindings = runtime.services()!.bindings;
if (scenario === "keep" || scenario === "orphan-keep") await bindings.keep("b1");
else if (scenario === "remove") await bindings.remove("b1");
else if (scenario === "orphan-remove") {
  const auth = bindings.gate.authorize({ kind: "park", botId: "b1", by: "orphan" });
  if ("authority" in auth) await bindings.continueRemoval(auth.start, auth.authority);
}
await new Promise(resolve => setTimeout(resolve, 500)); // an orphan Keep releases its key in the background
process.stdout.write("NOT_REACHED\n");
process.exit(3);
