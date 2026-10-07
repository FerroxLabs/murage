// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage: node scripts/action-guard-sample.mjs /path/to/copy/messages.db N > replies.jsonl
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export function sampleReplies(copyPath, count) {
  if (!copyPath || !Number.isSafeInteger(count) || count < 1) throw new Error("Provide a messages.db copy path and a positive reply count.");
  const roots = [...new Set([homedir(), userInfo().homedir])].map(home => resolve(home, ".murage"));
  const under = (path, root) => { const rest = relative(root, path); return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !rest.startsWith(sep)); };
  const path = resolve(copyPath);
  if (roots.some(root => under(path, root))) throw new Error("Use a database copy outside ~/.murage.");
  const canonical = realpathSync(path);
  if (roots.some(root => under(canonical, root))) throw new Error("Use a database copy outside ~/.murage.");
  const db = new DatabaseSync(canonical, { readOnly: true });
  try {
    const hasState = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_state'").get();
    const threads = db.prepare("SELECT thread_id,MAX(at) AS latest FROM messages GROUP BY thread_id ORDER BY latest DESC").all();
    const samples = [];
    for (const { thread_id } of threads) {
      const rows = db.prepare("SELECT role,kind,at,json FROM messages WHERE thread_id=? ORDER BY rowid").all(thread_id)
        .map(({ json, ...columns }) => ({ ...columns, ...JSON.parse(json) }));
      const byId = new Map(rows.map(row => [row.id, row]));
      const activeLeafId = hasState ? db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id=?").get(thread_id)?.active_leaf_id : rows.at(-1)?.id;
      if (!activeLeafId) continue;
      const linked = rows.some(row => Object.hasOwn(row, "parentId"));
      const path = [], seen = new Set();
      if (linked) {
        let row = byId.get(activeLeafId);
        while (row && !seen.has(row.id)) { path.push(row); seen.add(row.id); row = byId.get(row.parentId); }
        path.reverse();
      } else path.push(...rows.slice(0, rows.findIndex(row => row.id === activeLeafId) + 1));
      const authored = row => row.role === "bot" && row.kind === "text" && row.text && row.actorKind !== "murage" && !row.murage && !row.copyOf && row.removedText === undefined;
      const turns = new Map();
      for (const row of path.filter(authored)) turns.set(JSON.stringify([row.turnId ?? row.id, row.from?.botId]), row);
      for (const reply of turns.values()) {
        // A modern turn is sampled only once its terminal piece was recorded.
        if (reply.turnId && !reply.turnTerminal) continue;
        let end = path.indexOf(reply) + 1;
        while (reply.turnId && path[end]?.turnId === reply.turnId) end++;
        const branch = path.slice(0, end);
        const pieces = reply.turnId ? branch.filter(row => authored(row) && row.turnId === reply.turnId && row.from?.botId === reply.from?.botId) : [reply];
        samples.push({ threadId: thread_id, activeLeafId, reply, pieces, path: branch,
          records: branch.filter(row => row.kind !== "text"), label: null, split: null });
      }
    }
    return samples.sort((a, b) => b.reply.at - a.reply.at).slice(0, count);
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: action-guard-sample.mjs COPY_PATH N");
    for (const row of sampleReplies(process.argv[2], Number(process.argv[3]))) process.stdout.write(`${JSON.stringify(row)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
