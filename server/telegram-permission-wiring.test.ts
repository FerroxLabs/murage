import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { normalizeTelegramUpdate } from "./telegram-update.ts";
import { isQuestionCard, questionsForCard } from "../shared/questions.ts";
import { stripTypeScriptTypes } from "node:module";
// The actual channelApprovalActions expression from index.ts, types stripped.
// It now resolves the verified channel human and acts only for the workspace
// owner's task projection of the bot (owner-link gate), so those lookups are
// injected; "owner" is the only binding that resolves to the owner.
function channelApprovalActions(store: object, askMessageByRequest: Map<string, string>, answerRequest: unknown, questionReply: unknown, binding: () => string | undefined) {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const declaration = source.indexOf("const channelApprovalActions:");
  const start = source.indexOf("= (targetBotId,bindingId) =>", declaration);
  const end = source.indexOf("\nconst telegram =", start);
  expect(declaration).toBeGreaterThan(0); expect(start).toBeGreaterThan(declaration); expect(end).toBeGreaterThan(start);
  const expression = stripTypeScriptTypes(`(${source.slice(start + 2, end).trim().replace(/;$/, "")})`);
  const owner = { personId: "workspace-owner", bindingId: "owner", revision: 1 };
  const resolveHumanBinding = (id: string) => { if (id !== "owner") throw new Error("HUMAN_LINK_REQUIRED"); return owner; };
  const channelHumanIsOwner = (id: string | undefined) => id === "owner";
  const humanTask = (_store: unknown, _botId: string, principal: typeof owner) => principal === owner ? { threadId: "thread" } : null;
  return new Function("store", "askMessageByRequest", "createHash", "redactSecretsInText", "answerRequest", "isQuestionCard", "questionsForCard", "questionReply", "channelHumanIsOwner", "humanTask", "resolveHumanBinding", `return ${expression}("bot", arguments[11]);`)(
    store, askMessageByRequest, createHash, (text: string) => text, answerRequest, isQuestionCard, questionsForCard, questionReply, channelHumanIsOwner, humanTask, resolveHumanBinding, binding);
}
it("actual root approval actions bind live card, instance and thread and resolve only once", async () => {
  const bot = { id: "bot", name: "Fixture", threadId: "thread", modelSelection: { instanceId: "claude" } };
  const message = { id: "card", card: { requestId: "request", tool: "Write", subtitle: "fixture.txt", answered: undefined as string | undefined } };
  let currentChief: typeof bot | null = bot;
  const store = { bot: () => bot, workspaceChief: () => currentChief, messagesFor: () => [message], projectBotForTask: () => bot };
  const answerRequest = vi.fn(async () => { message.card.answered = "allow"; return "allowed-once"; });
  let binding: string | undefined = "person";
  const actions = channelApprovalActions(store, new Map([["thread:request", "card"]]), answerRequest, () => ({ kind: "none" }), () => binding);
  // Only the linked workspace owner is offered or may resolve an approval.
  expect(actions.pending()).toEqual([]);
  binding = "owner";
  const offered = actions.pending()[0];
  binding = "person";
  expect(await actions.resolve(offered, "allow")).toBe(false);
  binding = "owner";
  message.card.subtitle = "different action";
  expect(await actions.resolve(offered, "allow")).toBe(false);
  const changed = actions.pending()[0];
  currentChief = null;
  expect(actions.pending()).toEqual([]);
  expect(await actions.resolve(changed, "allow")).toBe(false);
  expect(answerRequest).not.toHaveBeenCalled();
  currentChief = bot;
  expect(await actions.resolve(changed, "allow")).toBe(true);
  expect(await actions.resolve(changed, "allow")).toBe(false);
  expect(answerRequest).toHaveBeenCalledExactlyOnceWith("thread", "claude", "request", "allow", undefined, { id: "bot", name: "Fixture" });
});
it("normalizes callbacks only from identifiable humans in private chats", () => {
  const callback = { id: "cb", from: { id: 7, is_bot: false }, message: { message_id: 3, chat: { id: 7, type: "private" } }, data: "nonce:a" };
  expect(normalizeTelegramUpdate({ update_id: 8, callback_query: callback })).toMatchObject({ kind: "callback", senderId: "7", chatId: "7", messageId: 3 });
  expect(normalizeTelegramUpdate({ update_id: 8, callback_query: { ...callback, from: { id: 7, is_bot: true } } })).toMatchObject({ kind: "ignored" });
  expect(normalizeTelegramUpdate({ update_id: 8, callback_query: { ...callback, message: { message_id: 3, chat: { id: -7, type: "group" } } } })).toMatchObject({ kind: "ignored" });
});
it("actual root approval actions publish a question with its questions and answer it through the validated question path (ASK3)", async () => {
  const bot = { id: "bot", name: "Ember", threadId: "thread", modelSelection: { instanceId: "claude" } };
  const questions = [{ id: "q1", question: "Which format?", options: [{ label: "Summary" }, { label: "Detailed" }], multiSelect: false, allowOther: true }];
  const message = { id: "card", card: { requestId: "request", subtitle: "Which format?", options: ["Summary", "Detailed"], questions, answered: undefined as string | undefined } };
  const secret = { id: "secret", card: { requestId: "request-2", subtitle: "Token?", options: [], questions: [{ id: "q1", question: "Token?", options: [], multiSelect: false, allowOther: true, secret: true }] } };
  const store = { bot: () => bot, workspaceChief: () => bot, messagesFor: () => [message, secret], projectBotForTask: () => bot };
  const answerRequest = vi.fn(async () => { message.card.answered = "answer"; return "answered"; });
  const questionReply = vi.fn((_thread: string, _request: string, body: any, skip: boolean) =>
    skip ? { kind: "deliver", behavior: "deny", message: "skipped" } : { kind: "deliver", behavior: "answer", message: "Detailed", answers: body.answers });
  const actions = channelApprovalActions(store, new Map([["thread:request", "card"], ["thread:request-2", "secret"]]), answerRequest, questionReply, () => "owner");
  // the question is offered with its questions; the secret one never leaves the app
  expect(actions.pending()).toEqual([{ id: "card", fingerprint: expect.any(String), summary: "Ember has a question", questions }]);
  const offered = actions.pending()[0];
  // a permission-style resolve never answers a question
  expect(await actions.resolve(offered, "allow")).toBe(false);
  expect(answerRequest).not.toHaveBeenCalled();
  expect(await actions.answer(offered, { behavior: "answer", answers: [{ id: "q1", selected: ["Detailed"] }] })).toEqual({ ok: true });
  expect(questionReply).toHaveBeenCalledExactlyOnceWith("thread", "request", { behavior: "answer", answers: [{ id: "q1", selected: ["Detailed"] }] }, false);
  expect(answerRequest).toHaveBeenCalledExactlyOnceWith("thread", "claude", "request", "answer", "Detailed", { id: "bot", name: "Ember" }, [{ id: "q1", selected: ["Detailed"] }]);
  // settled: the fingerprint no longer matches, so a second answer is refused
  expect(await actions.answer(offered, { behavior: "skip" })).toEqual({ ok: false, error: "This question is no longer open." });
  expect(answerRequest).toHaveBeenCalledTimes(1);
});
