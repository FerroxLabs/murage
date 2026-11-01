// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane E round 2 (ui-review-r2/REPORT.md): what the engine is actually handed.
// engine-payload-parity.test.ts compares helpers with an inlined oracle; this
// one drives the REAL server through its REAL dispatch (startTurn -> the Claude
// driver -> the CLI) and records, for each turn, what reached the engine: the
// prompt it was sent, its system prompt and its argv (resume cursor included).
// The same scenario was run on the base commit (fea681604) and its capture is
// kept in testing/engine-dispatch-golden.json; the lane must hand the engine
// exactly the same turns. The scenario covers quotes into older rows, a branch
// edit, a pending external update (queued on the task), a partitioned bot whose
// transcript holds a copy from another thread, resume across turns, and a turn
// on a thread the loaded-thread cache has evicted.
//
// A warm process's later turn records the system prompt that process read at
// launch, as the real CLI keeps it (the driver removes the file once it is
// read). The 1.0.9 fake CLI began replaying it, and the golden was regenerated
// then: only the four warm turns' systemPrompt moved, from null to their launch
// turn's prompt; every other field is the base's.
//
// Regenerate on a base checkout with ENGINE_DISPATCH_WRITE=<file>.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const GOLDEN = join(SERVER_DIR, "testing", "engine-dispatch-golden.json");
const GOLDEN_NOTES = join(SERVER_DIR, "testing", "engine-dispatch-golden-notes.json");
const SECRET = randomBytes(32).toString("hex");
const HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": SECRET } as const;
const posixOnly = describe.skipIf(process.platform === "win32");
const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };

type Capture = { label: string; prompt: unknown; systemPrompt: string | null; argv: string[] };

/** Everything that is different on every run, made the same: ids and hashes by
 * order of first appearance, the temp home, clock values and ports. */
function normalizer(home: string, port: number) {
  const seen = new Map<string, string>();
  const token = (kind: string, value: string) => {
    const key = `${kind}:${value}`;
    if (!seen.has(key)) seen.set(key, `<${kind}${seen.size}>`);
    return seen.get(key)!;
  };
  // The server resolves its home to the real path (macOS: /var is /private/var), so the run names the folder either way.
  const real = realpathSync(home);
  return (text: string) => text
    .split(real).join("<home>")
    .split(home).join("<home>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (value) => token("id", value))
    .replace(/\b[0-9a-f]{32,64}\b/g, (value) => token("hash", value))
    .replace(/\/tmp\/murage-[a-z-]+-[A-Za-z0-9]{6}\b/g, "/tmp/<murage-temp>")
    // the bot's first words are one of several greetings, picked at random, and memory remembers them
    // The remembered-context block is compared WHOLE: its notes are part of what
    // the engine is handed. Only what is volatile in it (ids, hashes, times) is
    // made the same by the rules below.
    // the prompt states the clock
    .replace(/\d{1,2}:\d{2} (?:am|pm) \(\d{1,2}:\d{2}\)/g, "<clock>")
    // ...and the date, which moves every day
    .replace(/It is now [A-Za-z]+, \d{1,2} [A-Za-z]+ \d{4}/g, "It is now <date>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<iso>")
    .replace(/\b1[67]\d{11}\b/g, "<ms>")
    .replace(new RegExp(`\\b${port}\\b`, "g"), "<port>")
    .replace(new RegExp(`\\b${port + 1}\\b`, "g"), "<port+1>");
}

/** The remembered-context block is the memory pipeline's output, and which of
 * its notes exist when a turn starts varies from run to run on the base too
 * (the same scenario, run on the base repeatedly, hands over different subsets
 * of the same notes). So the capture is compared in two parts: everything but
 * the block exactly, and the block's notes as a set against the notes the base
 * ever handed over in this scenario (engine-dispatch-golden-notes.json, the
 * union of 41 base runs, kept per turn). A note moves between neighbouring
 * turns with timing (on the base as much as here), so a note is accepted if the
 * base handed it over at any turn. A note the base never produced, or one
 * altered in any way, fails; only the timing-dependent choice of which notes
 * are present, and when, is left out. */
function splitNotes(capture: unknown): { rest: unknown; notes: string[] } {
  const notes: string[] = [];
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(/<remembered-context>\n(.*?)\n<\/remembered-context>/gs, (_all, body: string) => {
        for (const item of body.split(/\\n|\n/)) { const note = item.replace(/^[\s"\\]+|[\s"\\]+$/g, ""); if (note) notes.push(note); }
        return "<remembered-context>";
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    return value;
  };
  return { rest: walk(capture), notes: [...new Set(notes)].sort() };
}

posixOnly("what the engine is handed (lane E dispatch golden)", () => {
  it("is exactly what the base handed it, turn by turn", async () => {
    const port = await freePortBlock([0, 1]);
    const base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    const home = mkdtempSync(join(tmpdir(), "murage-dispatch-"));
    const data = join(home, ".murage");
    mkdirSync(data, { recursive: true });
    const dump = join(home, "engine-dump.json");
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: { claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_DUMP_EACH_TURN: "1", FAKE_CLAUDE_STATE: join(home, "fake-state") }, config: { cli: FAKE_CLAUDE } } },
    }));
    let child: ChildProcess | undefined;
    let stderr = "";
    const start = async () => {
      child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
        cwd: join(SERVER_DIR, ".."),
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          HOME: home, USERPROFILE: home, TZ: "UTC",
          MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: SECRET,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr!.on("data", (chunk) => (stderr += chunk));
      const deadline = Date.now() + 40_000;
      for (;;) {
        try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    };
    const stop = async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); child = undefined; };
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method, headers: { ...HEADERS, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };
    const captures: Capture[] = [];
    const thread = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Array<{ id: string; role: string; kind: string; text?: string }>;
    const idle = async (botId: string) => { const bots = (await api("GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; busy?: boolean }>; return !bots.find((bot) => bot.id === botId)?.busy; };
    /** One user turn, run to the end, and what the engine was handed for it. */
    const turn = async (label: string, bot: { id: string; threadId: string }, text: string, extra: Record<string, unknown> = {}, record = true) => {
      rmSync(dump, { force: true });
      const before = (await thread(bot.threadId)).length;
      const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text, ...extra });
      expect(sent.status, `${label}: ${JSON.stringify(sent.body)}`).toBe(202);
      await expect.poll(async () => existsSync(dump) && (await thread(bot.threadId)).length >= before + 2 && (await idle(bot.id)), { timeout: 40_000, interval: 100 }).toBe(true);
      const raw = JSON.parse(readFileSync(dump, "utf8"));
      if (record) captures.push({ label, prompt: raw.prompt, systemPrompt: raw.systemPrompt ?? null, argv: raw.argv ?? [] });
    };
    /** Each bot opens with one of several greetings picked at random; it is replayed in later prompts. */
    const greetings = new Set<string>();
    const create = async (name: string) => {
      const created = await api("POST", "/api/bots", { name, modelSelection, requireAvailableModel: true });
      expect(created.status).toBe(201);
      const bot = created.body.bot as { id: string; threadId: string };
      expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);
      for (const row of await thread(bot.threadId)) if (row.role === "bot" && row.text) greetings.add(row.text);
      return bot;
    };
    try {
      await start();
      const main = await create("Dispatch Otter");
      const partitioned = await create("Walled Otter");
      const source = await create("Source Otter");
      // quotes into older rows, resume across turns
      await turn("first", main, "The launch date is the 14th, keep that in mind.");
      const early = (await thread(main.threadId)).find((m) => m.role === "user")!;
      for (let i = 0; i < 3; i++) await turn(`filler ${i}`, main, `filler line ${i}`);
      await turn("quote", main, "What date did I say?", { replyToId: early.id });
      // a branch edit: the question forks and the turn reruns
      const question = (await thread(main.threadId)).filter((m) => m.role === "user" && m.text === "What date did I say?").at(-1)!;
      const edited = await api("POST", `/api/bots/${main.id}/messages/${question.id}/edit`, { text: "Which date did I give you?" });
      expect(edited.status).toBe(202);
      await expect.poll(async () => existsSync(dump) && (await idle(main.id)) && (await thread(main.threadId)).some((m) => m.text === "Which date did I give you?"), { timeout: 40_000, interval: 100 }).toBe(true);
      await expect.poll(async () => (await idle(main.id)), { timeout: 20_000 }).toBe(true);
      const afterEdit = JSON.parse(readFileSync(dump, "utf8"));
      captures.push({ label: "edit", prompt: afterEdit.prompt, systemPrompt: afterEdit.systemPrompt ?? null, argv: afterEdit.argv ?? [] });
      // the loaded-thread cache evicts: 24 other conversations are used
      for (let i = 0; i < 24; i++) {
        const other = await create(`Other Otter ${i}`);
        await turn(`other ${i}`, other, "hello", {}, false);
      }
      await turn("after eviction", main, "Remind me what we settled.");
      // an update from outside the engine's session, queued on the task; a
      // partitioned bot whose transcript holds a copy from another thread
      await stop();
      const db = new DatabaseSync(join(data, "messages.db"));
      const leaf = (threadId: string) => (db.prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id=?").get(threadId) as { id: string }).id;
      const put = (threadId: string, row: { id: string; at: number; role: string; kind: string; text?: string; [key: string]: unknown }) => {
        db.prepare("INSERT INTO messages (thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)").run(threadId, row.id, row.at, row.role, row.kind, row.text ?? null, JSON.stringify(row));
        db.prepare("UPDATE thread_state SET active_leaf_id=? WHERE thread_id=?").run(row.id, threadId);
      };
      const external = { id: "ext-update-1", at: Date.now(), role: "bot", kind: "text", text: "Teammate finished: the report is ready.", from: { botId: "teammate-x", name: "Teammate" }, parentId: leaf(main.threadId) };
      put(main.threadId, external);
      const sourceRow = { id: "src-row-1", at: Date.now(), role: "bot", kind: "text", text: "Private note from another bot's thread.", from: { botId: source.id, name: "Source Otter" }, parentId: leaf(source.threadId) };
      put(source.threadId, sourceRow);
      const copy = { id: "copy-row-1", at: Date.now(), role: "bot", kind: "text", text: "A copy of the private note.", copyOf: { threadId: source.threadId, messageIds: [sourceRow.id] }, from: { botId: source.id, name: "Source Otter" }, parentId: leaf(partitioned.threadId) };
      put(partitioned.threadId, copy);
      db.close();
      const botsFile = join(data, "bots.json");
      const bots = JSON.parse(readFileSync(botsFile, "utf8")) as Array<{ id: string; threadId: string; partitionedAt?: number; tasks?: Array<{ threadId: string; externalUpdates?: string[] }> }>;
      for (const bot of bots) {
        if (bot.id === main.id) for (const task of bot.tasks ?? []) if (task.threadId === main.threadId) task.externalUpdates = [external.id];
        if (bot.id === partitioned.id) bot.partitionedAt = Date.now();
      }
      writeFileSync(botsFile, JSON.stringify(bots, null, 2));
      await start();
      await turn("external update", main, "Anything new from the team?");
      await turn("partitioned", partitioned, "What do you know?");
      await turn("resumed", main, "Thanks, one more thing.");
    } finally {
      await stop();
    }
    const normalize = normalizer(home, port);
    const unGreet = (text: string) => [...greetings].reduce((out, greeting) => out.split(JSON.stringify(greeting).slice(1, -1)).join("<greeting>"), text);
    const normalized = captures.map((capture) => JSON.parse(normalize(unGreet(JSON.stringify(capture)))) as Capture);
    const split = normalized.map((capture) => ({ label: capture.label, ...splitNotes(capture) }));
    await removeTempDir(home);
    if (process.env.ENGINE_DISPATCH_WRITE) writeFileSync(process.env.ENGINE_DISPATCH_WRITE, JSON.stringify(split, null, 2));
    else {
      // Everything handed to the engine except the notes block is exactly the base's...
      expect(split.map((entry) => entry.rest)).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
      // ...and every note it was handed is one the base handed over.
      const universe = JSON.parse(readFileSync(GOLDEN_NOTES, "utf8")) as Record<string, string[]>;
      // A note's "mN" label is its rank in the list. Equal-scoring notes now rank by record id (ref-order.ts, msearch round 4:
      // never by the order an index happened to hold them), and ids are random per run, so two equally relevant notes swap
      // labels between runs. The words of the note are what is compared; the rank label is not.
      const unrank = (note: string) => note.replace(/^- m\d+ /, "- m# ");
      const everNoted = new Set(Object.values(universe).flat().map(unrank));
      for (const entry of split) {
        expect(universe[entry.label], entry.label).toBeDefined();
        expect(entry.notes.filter((note) => !everNoted.has(unrank(note))), `${entry.label}: notes the base never handed over`).toEqual([]);
      }
    }
  }, 600_000);
});
