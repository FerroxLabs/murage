// W4 child (M6 test fixture): show a card, tap it, and die by SIGKILL right after the writer committed the setting and its J0
// row to disk (writer.json), before settleSettingCard runs. The parent restarts on the same files and reads the card.
import { renameSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { CHAT_CARD_WRITER } from "../../../shared/settings-chat.ts";
import { DECLARATIONS, writerKey } from "../catalog.ts";
import { openCardStore } from "../cards.ts";
import { createSettingsChat } from "../routes.ts";

const dir = process.argv[2]!;
const db = new DatabaseSync(join(dir, "cards.db"));
const tx = <T>(op: (d: DatabaseSync) => T): T => {
  if (db.isTransaction) return op(db);
  db.exec("BEGIN IMMEDIATE");
  try { const out = op(db); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
};
const cards = openCardStore(db, tx);
const bot = { id: "dax", name: "Dax", threadId: "th-dax", modelSelection: "model-a", tasks: [] };
const journal: Record<string, unknown> = {};
const chat = createSettingsChat({
  cards,
  catalog: {
    inventory: [{ id: "bot.model", label: "Model", path: "Settings > Bots > Model", scope: "bot", interaction: "immediate" }],
    declarations: DECLARATIONS, storeBuild: false, journalWriters: new Set([CHAT_CARD_WRITER]), atomic: new Set([writerKey("bot.model", "bot")]),
    chatControls: new Set(["BotModelChatControl"]), routes: new Set(["PATCH /api/bots/:botId"]), expectRoutes: new Set(["PATCH /api/bots/:botId"]),
  },
  bot: () => bot,
  journal: { lookup: (changeId) => journal[changeId] ? { state: "saved", row: journal[changeId] as never } : { state: "notSaved" } },
  activeGeneration: () => "1",
  turnOrigin: () => ({ ownerText: true, noLimitsOrigin: "owner", depth: 0, internalEvent: false }),
  threadPlace: () => "owner",
  busy: () => false,
  postText: () => {},
  postCard: () => {},
  async dispatchWriter({ body, changeId }) {
    // the writer's commit: the setting and its J0 row land together in one durable file, then the process dies before settle
    bot.modelSelection = String(body.modelSelection);
    journal[changeId] = { changeId, actor: { kind: "owner" }, writer: CHAT_CARD_WRITER, settingId: "bot.model", bot: "dax", after: body.modelSelection, at: Date.now() };
    const writes = [{ path: "/api/bots/dax", body, changeId }];
    writeFileSync(join(dir, "writer.json.tmp"), JSON.stringify({ settings: { dax: { modelSelection: bot.modelSelection } }, journal, writes }));
    renameSync(join(dir, "writer.json.tmp"), join(dir, "writer.json"));
    process.kill(process.pid, "SIGKILL");
    return { status: 200 };
  },
});
const shown = await chat.internalRoute({ method: "POST", path: "/api/internal/settings-chat/show", readBody: async () => ({ settingRef: { id: "bot.model", code: "chat" }, reason: "cheaper" }) }, { threadId: "th-dax", botId: "dax", generation: "1" });
const cardId = (shown!.body as { cardId: string }).cardId;
const changeId = "change-killed-0001";
writeFileSync(join(dir, "card.json"), JSON.stringify({ cardId, changeId }));
await chat.cardRoute({ method: "POST", path: `/api/settings-chat/cards/${cardId}/apply`, readBody: async () => ({ value: "model-c", expect: "model-a", cardGen: 1, changeId }) },
  { mayApprove: true, caller: { kind: "local", route: { desktop: true, companion: false, door: false, bot: false }, surface: "desktop" } });
