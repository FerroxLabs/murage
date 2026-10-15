// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The paged export writes exactly the bytes and headers the one-shot route wrote before the export was streamed. The one-shot side below is
// that route's body copied verbatim from git (e1452bdd5^:server/index.ts, GET /api/threads/:id/export): its own speaker rule and its own
// inline chain of notice sentences, the whole active path loaded at once. The streamed side runs what the route runs now: the export reader
// and the speakers the route passes (thread-export.ts exportSpeakers). The fixture has what changes a branch walk (an edit that forks the
// conversation, whose abandoned rows must stay out), a row patched after it was written, attachments and artifact ids, a screen frame with
// pixels, an answered card, tool rows and notices the route rewords, a line from another bot, and text with quotes, newlines and non-ASCII;
// then the branch grows across the reader's row count pages (5,000 rows each: 4,999, 5,000, 5,001 and 10,001 rows in the thread).
import { rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { browserUnavailableDisplayName } from "../shared/browser-unavailable.ts";
import { folderTrustDisplayName } from "../shared/folder-trust.ts";
import { hostStoppedActivityName, hostStoppedDisplayName } from "../shared/host-stop.ts";
import { imagesLeftOutActivityName, imagesLeftOutDisplayName } from "../shared/images-left-out.ts";
import { sendNoticeDisplayName } from "../shared/send-notice.ts";
import { imagesNotSentDisplayName } from "../shared/turn-image-note.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import * as mdb from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import { exportSpeakers, streamThreadExport } from "./thread-export.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

type Captured = { status: number; headers: Record<string, string>; body: string };
function capture() {
  const out: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    destroyed: false, writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers; },
    write(chunk: string) { out.body += chunk; return true; },
    end(chunk?: string) { if (chunk !== undefined) out.body += chunk; (res as { writableEnded: boolean }).writableEnded = true; },
    on() {}, off() {},
  };
  return { res, out };
}

/** The one-shot route body, verbatim from e1452bdd5^:server/index.ts (only `store`, `url`, `cfg`, `bot` became arguments). */
function legacyRoute(res: ReturnType<typeof capture>["res"], store: Store, threadId: string, bot: { name: string } | undefined, title: string, format: string, cfg: { profile?: { name?: string } }) {
  const filename = (title.replace(/[^\w\- ]+/g, "").trim() || "conversation").slice(0, 60);
  const messages = store.activePath(threadId);
  if (format === "json") {
    // pixels stripped — an export is for reading and archiving, and a
    // base64 desktop frame is neither
    const slim = messages.map(({ png: _png, mime: _mime, ...rest }) => rest);
    res.writeHead(200, {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${filename}.json"`,
    });
    return res.end(JSON.stringify({ name: title, threadId, messages: slim }, null, 2));
  }
  const userName = cfg.profile?.name?.trim() || "User";
  const lines: string[] = [`# ${title}`, ""];
  for (const msg of messages) {
    const who = msg.role === "user" ? userName : (msg.from?.name ?? bot?.name ?? "Bot");
    if (msg.kind === "text" && msg.text) lines.push(`**${who}:**`, "", msg.text, "");
    else if (msg.kind === "activity" && msg.tool) lines.push(`> ${hostStoppedDisplayName(msg.tool.name) ?? sendNoticeDisplayName(msg.tool.name) ?? folderTrustDisplayName(msg.tool.name) ?? browserUnavailableDisplayName(msg.tool.name) ?? imagesLeftOutDisplayName(msg.tool.name, who) ?? imagesNotSentDisplayName(msg.tool.name) ?? msg.tool.name}`, "");
    else if (msg.kind === "screen") lines.push("> [screen capture]", "");
    else if (msg.kind === "options" && msg.card) {
      lines.push(`> ${msg.card.title}${msg.card.answered ? ` (answered: ${msg.card.answered})` : ""}`, "");
    }
  }
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}.md"`,
  });
  return res.end(lines.join("\n"));
}

const PROFILE = { profile: { name: " Sam Owner " } };
const TITLE = "Launch \"plan\" / Q3";
function oneShot(threadId: string, botName: string, format: "json" | "markdown"): Captured {
  const { res, out } = capture();
  legacyRoute(res, new Store(selection), threadId, { name: botName }, TITLE, format, PROFILE);
  return out;
}
/** What the route runs now, with the arguments it passes (filename and speakers derived the same way). */
async function streamed(store: Store, threadId: string, botName: string, format: "json" | "markdown", pageRows?: number): Promise<Captured> {
  const { res, out } = capture();
  const filename = (TITLE.replace(/[^\w\- ]+/g, "").trim() || "conversation").slice(0, 60);
  const userName = PROFILE.profile.name.trim() || "User";
  const ok = await streamThreadExport({ res: res as never, reader: store.branchExportReader(threadId, pageRows), format, name: TITLE, threadId, filename, ...exportSpeakers(userName, botName) });
  expect(ok).toBe(true);
  return out;
}
/** The reader alone with no time at all per slice: the row count and the walk yield as often as they can, and still hand back the branch. */
function readerIds(threadId: string, pageRows: number): { ids: string[]; calls: number } {
  const reader = new Store(selection).branchExportReader(threadId, pageRows);
  const ids: string[] = [];
  let calls = 0;
  for (;;) {
    const slice = reader.next(0);
    calls++;
    ids.push(...slice.messages.map((m) => m.id));
    if (slice.done) return { ids, calls };
    if (calls > 1_000_000) throw new Error("the reader never finished");
  }
}

it("the paged export is byte for byte the one-shot route, across a forked branch, notices, patched rows, pixels, cards and the 5,000-row count pages", async () => {
  const seed = new Store(selection);
  const bot = seed.createBot();
  const t = bot.threadId;
  seed.appendMessage(t, { role: "user", kind: "text", text: "Plan the \"launch\"\nwith notes: café, 東京, emoji 🚀" });
  seed.appendMessage(t, { role: "bot", kind: "text", text: "First answer", artifactIds: ["art-1", "art-2"] });
  seed.appendMessage(t, { role: "bot", kind: "activity", tool: { name: "Read the brief", ok: true } } as never);
  seed.appendMessage(t, { role: "bot", kind: "activity", tool: { name: hostStoppedActivityName("the computer went to sleep"), ok: true } } as never);
  seed.appendMessage(t, { role: "bot", kind: "activity", tool: { name: imagesLeftOutActivityName(2), ok: true } } as never);
  seed.appendMessage(t, { role: "bot", kind: "text", text: "A word from a teammate", from: { botId: "other", name: "Ada", color: "#123456" } } as never);
  seed.appendMessage(t, { role: "bot", kind: "screen", text: "frame", png: "iVBORw0KGgo=", mime: "image/png" } as never);
  const asked = seed.appendMessage(t, { role: "user", kind: "text", text: "Use this picture", attachments: [{ kind: "image", path: "/tmp/a.png", mime: "image/png" }] });
  const card = seed.appendMessage(t, { role: "bot", kind: "options", text: "Pick one", card: { title: "Which plan?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } } as never);
  seed.patchMessage(t, card.id, { card: { ...card.card!, answered: "b" } });
  const reply = seed.appendMessage(t, { role: "bot", kind: "text", text: "draft" });
  seed.patchMessage(t, reply.id, { text: "Edited reply after the fact" });
  for (let i = 0; i < 9; i++) seed.appendMessage(t, { role: i % 2 ? "bot" : "user", kind: "text", text: `old branch ${i}` });
  // the owner edits an earlier line: the conversation forks there and the rows after it leave the visible branch
  const fork = seed.branchMessage(t, asked.id, "Use this picture instead");
  expect(fork).toBeTruthy();
  for (let i = 0; i < 11; i++) seed.appendMessage(t, { role: i % 2 ? "user" : "bot", kind: "text", text: `new branch ${i}\n  indented "q"` });

  const check = async (label: string, pageSizes: ReadonlyArray<number | undefined>) => {
    const path = new Store(selection).activePath(t); // the one-shot read: the whole thread loaded
    expect(path.some((m) => m.text === "old branch 0"), label).toBe(false);
    for (const format of ["json", "markdown"] as const) {
      const want = oneShot(t, bot.name, format);
      expect(want.status).toBe(200);
      for (const pageRows of pageSizes) {
        expect(await streamed(new Store(selection), t, bot.name, format, pageRows), `${label} ${format} unloaded, pages of ${pageRows ?? "default"}`).toEqual(want);
      }
      const loaded = new Store(selection);
      loaded.messagesFor(t); // the thread in memory: the reader hands back slices of its own path
      expect(await streamed(loaded, t, bot.name, format, 3), `${label} ${format} loaded`).toEqual(want);
    }
    const read = readerIds(t, 200);
    expect(read.ids, `${label} reader with no time per slice`).toEqual(path.map((m) => m.id));
    return { path, calls: read.calls };
  };
  const forked = (await check("forked branch", [1, 3, 200, undefined])).path;
  expect(forked.some((m) => m.text === "Use this picture instead")).toBe(true);
  expect(forked.some((m) => m.png)).toBe(true); // the frame is on the branch, and its pixels are stripped by both
  const markdown = oneShot(t, bot.name, "markdown").body;
  expect(markdown).toContain("> Stopped: the computer went to sleep");
  expect(markdown).toContain(`> ${bot.name} can't see images, so I left the pictures out.`);
  expect(markdown).toContain("**Ada:**");
  expect(markdown).toContain("**Sam Owner:**");

  // the branch grows across the reader's count pages (EXPORT_COUNT_PAGE_ROWS = 5,000): every row of the thread counts, the abandoned ones too
  let leaf = forked.at(-1)!.id, n = 0;
  const growTo = (rows: number) => {
    while (mdb.threadRowCount(t) < rows) {
      n++;
      const message = { id: `bulk-${n}`, role: n % 2 ? "user" : "bot", kind: "text", text: `bulk line ${n}\n"quoted" ${n % 7 ? "plain" : "東京 🚀"}`, at: 1_800_000_000_000 + n, parentId: leaf } as Message;
      mdb.appendMessage(t, message);
      leaf = message.id;
    }
    expect(mdb.threadRowCount(t)).toBe(rows);
  };
  for (const rows of [4_999, 5_000, 5_001, 10_001]) {
    growTo(rows);
    const { path, calls } = await check(`${rows} rows`, [200, undefined]);
    expect(path.at(-1)!.id).toBe(leaf);
    expect(path.length).toBe(forked.length + n);
    expect(calls).toBeGreaterThan(Math.ceil(path.length / 200)); // the count and the walk yielded on the way
  }

  // back on the original branch: its rows return, and the fork's (over 10,000 rows now) leave, though the count still covers them
  const back = new Store(selection);
  expect(back.setActiveLeaf(t, reply.id)).toBeTruthy();
  const original = new Store(selection).activePath(t);
  expect(original.some((m) => m.text === "Edited reply after the fact")).toBe(true);
  expect(original.some((m) => m.id.startsWith("bulk-"))).toBe(false);
  for (const format of ["json", "markdown"] as const) {
    expect(await streamed(new Store(selection), t, bot.name, format, 3), `original ${format}`).toEqual(oneShot(t, bot.name, format));
  }
}, 300_000);
