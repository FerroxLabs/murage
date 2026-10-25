// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot's private Codex or Grok scope (`<data>/native/<engine>-scope/<id>`, drivers/scoped-cli-home.ts) holding two conversations of
// the same bot: the one being deleted (its words are `canary`) and another one (`bystander`) that must stay byte for byte.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";

import { fuigoSessionKey } from "../engine-keys.ts";
import { walDatabase } from "./engine-history-fixtures.ts";

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const write = (file: string, text: string | Buffer = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
/** drivers/scoped-cli-home.ts scopeId */
export const fixtureScopeId = (realHome: string, botId: string): string => createHash("sha256").update(JSON.stringify([realHome, botId])).digest("hex").slice(0, 16);

export interface ScopeFixture {
  engine: "codex" | "grok";
  home: string;
  canary: string;
  bystander: string;
  /** files of the deleted conversation that must be gone */
  gone: string[];
  /** files of the other conversation, with their bytes now: must be the same after */
  kept: Map<string, string>;
  /** files only rows of which go (shared by both conversations) */
  shared: string[];
  /** problems with the other conversation's files and rows */
  checkBystander(): string[];
}

export const TID = "019a1111-aaaa-7bbb-8ccc-000000000001";
export const OID = "019a1111-aaaa-7bbb-8ccc-0000000000ff";

/** Makes `<native>/<engine>-scope/<scopeId(realHome, botId)>` with a valid marker. `folder`: the deleted conversation's working folder;
 * `otherFolder`: the other conversation's (same bot). */
export function buildScope(native: string, engine: "codex" | "grok", botId: string, realHome: string, folder: string, otherFolder: string, extra: Record<string, unknown> = {}): ScopeFixture {
  const home = join(native, `${engine}-scope`, fixtureScopeId(realHome, botId));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".murage-scope.json"), JSON.stringify({ contract: 2, realHome, botId, subdir: "", share: engine === "codex" ? ["auth.json"] : ["auth.json"], launched: true, ...extra }));
  const canary = `canary-scope-${engine}-7731`, bystander = `bystander-scope-${engine}-4410`;
  const gone: string[] = [], shared: string[] = [];
  const kept = new Map<string, string>();
  const keep = (file: string, text: string) => { write(file, text); kept.set(file, text); };
  keep(join(home, "auth.json"), "{\"login\":\"kept\"}");
  keep(join(home, "config.toml"), "model = \"x\"\n");
  if (engine === "codex") {
    const meta = (id: string, cwd: string, text: string) => dump({ type: "session_meta", payload: { id, cwd } }) + dump({ type: "event", text });
    const ours = join(home, "sessions", "2026", "10", "20", `rollout-2026-10-20T10-00-00-${TID}.jsonl`);
    write(ours, meta(TID, folder, canary));
    gone.push(ours);
    keep(join(home, "sessions", "2026", "10", "20", `rollout-2026-10-20T11-00-00-${OID}.jsonl`), meta(OID, otherFolder, bystander));
    write(join(home, "history.jsonl"), dump({ session_id: TID, ts: 1, text: canary }) + dump({ session_id: OID, ts: 2, text: bystander }));
    write(join(home, "session_index.jsonl"), dump({ id: TID, thread_name: canary }) + dump({ id: OID, thread_name: bystander }));
    shared.push(join(home, "history.jsonl"), join(home, "session_index.jsonl"));
    write(join(home, "shell_snapshots", `${TID}.1.sh`), canary);
    gone.push(join(home, "shell_snapshots", `${TID}.1.sh`));
    keep(join(home, "shell_snapshots", `${OID}.1.sh`), bystander);
    mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
    walDatabase(join(home, "state_1.sqlite"), (db) => {
      db.exec("CREATE TABLE threads(id TEXT, title TEXT); CREATE TABLE logs(thread_id TEXT, body TEXT);");
      for (const [id, text] of [[TID, canary], [OID, bystander]] as const) { db.prepare("INSERT INTO threads VALUES(?,?)").run(id, text); db.prepare("INSERT INTO logs VALUES(?,?)").run(id, text); }
    });
  } else {
    const ours = join(home, "sessions", fuigoSessionKey(folder));
    write(join(ours, "s-ours", "chat_history.jsonl"), dump({ text: canary }));
    gone.push(ours);
    keep(join(home, "sessions", fuigoSessionKey(otherFolder), "s-other", "chat_history.jsonl"), dump({ text: bystander }));
    write(join(home, "logs", "unified.jsonl"), dump({ sid: "s-ours", text: canary }) + dump({ sid: "s-other", text: bystander }));
    shared.push(join(home, "logs", "unified.jsonl"));
  }
  return {
    engine, home, canary, bystander, gone, kept, shared,
    checkBystander() {
      const problems: string[] = [];
      for (const [file, text] of kept) {
        if (!existsSync(file)) problems.push(`${file} was removed`);
        else if (readFileSync(file, "utf8") !== text) problems.push(`${file} changed`);
      }
      for (const file of shared) {
        const rows = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
        if (rows.filter((line) => line.includes(bystander)).length !== 1) problems.push(`${file} lost the other conversation's row`);
      }
      return problems;
    },
  };
}
