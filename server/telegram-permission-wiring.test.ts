import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { normalizeTelegramUpdate } from "./telegram-update.ts";
import { isQuestionCard, questionsForCard } from "../shared/questions.ts";
it("actual root approval actions bind live card, instance and thread and resolve only once", async () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("approvals: targetBotId =>", source.indexOf("const telegram = new TelegramService"));
  const end = source.indexOf("\n  enqueue:", start);
  const expression = source.slice(start + "approvals: ".length, end).trim().replace(/,$/, "");
  const bot = { id: "bot", name: "Fixture", threadId: "thread", modelSelection: { instanceId: "claude" } };
  const message = { id: "card", card: { requestId: "request", tool: "Write", subtitle: "fixture.txt", answered: undefined as string | undefined } };
  const store = { bot: () => bot, messagesFor: () => [message] };
  const answerRequest = vi.fn(async () => { message.card.answered = "allow"; return "allowed-once"; });
  const actions = new Function("store", "askMessageByRequest", "createHash", "redactSecretsInText", "answerRequest", "isQuestionCard", "questionsForCard", "questionReply", `return (${expression})("bot");`)(store, new Map([["thread:request", "card"]]), createHash, (text: string) => text, answerRequest, isQuestionCard, questionsForCard, () => ({ kind: "none" }));
  const offered = actions.pending()[0];
  message.card.subtitle = "different action";
  expect(await actions.resolve(offered, "allow")).toBe(false);
  const changed = actions.pending()[0];
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
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("approvals: targetBotId =>", source.indexOf("const telegram = new TelegramService"));
  const end = source.indexOf("\n  enqueue:", start);
  const expression = source.slice(start + "approvals: ".length, end).trim().replace(/,$/, "");
  const bot = { id: "bot", name: "Ember", threadId: "thread", modelSelection: { instanceId: "claude" } };
  const questions = [{ id: "q1", question: "Which format?", options: [{ label: "Summary" }, { label: "Detailed" }], multiSelect: false, allowOther: true }];
  const message = { id: "card", card: { requestId: "request", subtitle: "Which format?", options: ["Summary", "Detailed"], questions, answered: undefined as string | undefined } };
  const secret = { id: "secret", card: { requestId: "request-2", subtitle: "Token?", options: [], questions: [{ id: "q1", question: "Token?", options: [], multiSelect: false, allowOther: true, secret: true }] } };
  const store = { bot: () => bot, messagesFor: () => [message, secret] };
  const answerRequest = vi.fn(async () => { message.card.answered = "answer"; return "answered"; });
  const questionReply = vi.fn((_thread: string, _request: string, body: any, skip: boolean) =>
    skip ? { kind: "deliver", behavior: "deny", message: "skipped" } : { kind: "deliver", behavior: "answer", message: "Detailed", answers: body.answers });
  const actions = new Function("store", "askMessageByRequest", "createHash", "redactSecretsInText", "answerRequest", "isQuestionCard", "questionsForCard", "questionReply", `return (${expression})("bot");`)(
    store, new Map([["thread:request", "card"], ["thread:request-2", "secret"]]), createHash, (text: string) => text, answerRequest, isQuestionCard, questionsForCard, questionReply);
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
