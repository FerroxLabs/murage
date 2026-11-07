import { expect, it } from "vitest";
import { storedReplyTarget, type ReplyTargetStore } from "./reply-target.ts";
import type { Message, BotRecord, GroupRecord } from "../store.ts";
function fixture() {
  let message = { id: "message", role: "bot", kind: "text", text: "Original source", turnTerminal: true, turnId: "provider" } as Message;
  let bot = { id: "bot", name: "Sable", voice: "marin" } as BotRecord;
  let room: GroupRecord | undefined;
  const store: ReplyTargetStore = { messageById: (thread, id) => thread === "thread" && id === message.id ? message : undefined, botByThread: () => bot, bot: id => id === bot.id ? bot : null, groupByThread: () => room };
  const target = (owner = true, busy = false) => storedReplyTarget(store, "thread", "message", owner, () => busy);
  return { target, message: (patch: Partial<Message>) => { message = { ...message, ...patch }; }, bot: (patch: Partial<BotRecord>) => { bot = { ...bot, ...patch }; }, room: (value: GroupRecord) => { room = value; } };
}
it("manual historical terminal and legacy settled history work while current partials and owner rows cannot speak", () => {
  const f = fixture(); expect(f.target()).toMatchObject({ source: "Original source", eligible: true });
  f.message({ turnTerminal: false }); expect(() => f.target()).toThrow();
  f.message({ turnId: undefined }); expect(f.target().source).toBe("Original source"); expect(() => f.target(true, true)).toThrow();
  for (const patch of [{ role: "user" as const }, { actorKind: "murage" as const }, { kind: "activity" as const }]) { const g = fixture(); g.message(patch); expect(() => g.target()).toThrow(); }
  expect(() => f.target(false)).toThrow(); f.bot({ hidden: true }); expect(() => f.target()).toThrow();
});
it("room read aloud requires the stored author's current visible membership and protects the complete name later", () => {
  const f = fixture(); f.message({ from: { botId: "bot", name: "Sable", color: "blue" } }); f.room({ memberIds: ["bot"] } as GroupRecord);
  expect(f.target()).toMatchObject({ prefix: "Sable", botId: "bot" }); f.room({ memberIds: [] } as unknown as GroupRecord); expect(() => f.target()).toThrow();
});
