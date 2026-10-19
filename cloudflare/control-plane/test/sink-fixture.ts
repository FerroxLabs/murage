// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared by the handler-level mail sink tests (Astra TRUSTCODE-1 P3-3): the staging sink engaged on the test D1 with NO injected sender,
// a real-provider stand-in that records anything reaching it, and the sink table. src/email.ts.
import { env } from "cloudflare:workers";
import sinkSql from "../migrations-mailsink/0001_sink.sql?raw";

/** What reached the real EMAIL binding stand-in. Must stay empty while the sink is engaged. */
export const realSends: { to: string; subject: string }[] = [];
const fakeEmail = { async send(m: { to: string; subject: string }) { realSends.push({ to: m.to, subject: m.subject }); } };

/** The bindings and vars of an engaged staging sink, over the test D1 standing in for the sink database. */
export const engagedSink = (allowlist = "@example.test"): Record<string, unknown> =>
  ({ EMAIL: fakeEmail, MAIL_SINK: env.DB, STAGING_MAIL_SINK: "1", MAIL_SINK_ALLOWLIST: allowlist });

export async function installSink() {
  const sql = sinkSql.split("\n").map((l: string) => l.replace(/--.*$/, "")).join("\n");
  await env.DB.prepare("DROP TABLE IF EXISTS staging_mail_sink").run();
  for (const stmt of sql.split(";").map((x: string) => x.trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
  realSends.length = 0;
}
export async function dropSink() {
  await env.DB.prepare("DROP TABLE IF EXISTS staging_mail_sink").run();
  realSends.length = 0;
}
export const sunk = async () =>
  (await env.DB.prepare("SELECT to_addr,subject,text FROM staging_mail_sink ORDER BY created_at,rowid").all<{ to_addr: string; subject: string; text: string }>()).results;
