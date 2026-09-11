import { describe, expect, it, vi } from "vitest";
import { TelegramTransport } from "./telegram-transport.ts";
const token = "123456:FAKE_TOKEN_CANARY_1234567890";
const ok = (result: unknown) => Response.json({ ok: true, result });
describe("bounded Telegram transport", () => {
  it("edits exact approval message and removes its inline buttons", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(ok({ message_id: 7, chat: { id: 7 } }));
    const transport = new TelegramTransport({ token, fetch: fetcher });
    await transport.settleApprovalMessage({ chatId: "7", messageId: 7, text: "Fixture\nDenied." });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ chat_id: "7", message_id: 7, text: "Fixture\nDenied.", reply_markup: { inline_keyboard: [] } });
    await expect(transport.settleApprovalMessage({ chatId: "invalid", messageId: 7, text: "No" })).rejects.toMatchObject({ code: "invalid-request" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("delivers HTML and owner buttons and acknowledges callbacks", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ message_id: 7, chat: { id: 7 } })).mockResolvedValueOnce(ok(true));
    const transport = new TelegramTransport({ token, fetch: fetcher });
    await transport.sendMessage({ chatId: "7", text: "<b>Ready</b>", parseMode: "HTML", buttons: [{ text: "Allow once", data: "nonce:a" }] });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Allow once", callback_data: "nonce:a" }]] } });
    await transport.answerCallbackQuery({ id: "callback", text: "Allowed once." });
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({ callback_query_id: "callback", text: "Allowed once." });
  });
  it("sends a multi-row question keyboard and edits a question in place keeping its keyboard (ASK3)", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ message_id: 7, chat: { id: 7 } })).mockResolvedValueOnce(ok({ message_id: 7, chat: { id: 7 } }));
    const transport = new TelegramTransport({ token, fetch: fetcher });
    const keyboard = [[{ text: "Summary", data: "n:q0:o0" }], [{ text: "Detailed", data: "n:q0:o1" }], [{ text: "Reply with text", data: "n:q0:w" }, { text: "Skip question", data: "n:q0:x" }]];
    await transport.sendMessage({ chatId: "7", text: "Which format?", keyboard });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ chat_id: "7", text: "Which format?", reply_markup: { inline_keyboard: [
      [{ text: "Summary", callback_data: "n:q0:o0" }], [{ text: "Detailed", callback_data: "n:q0:o1" }],
      [{ text: "Reply with text", callback_data: "n:q0:w" }, { text: "Skip question", callback_data: "n:q0:x" }],
    ] } });
    await transport.editQuestionMessage({ chatId: "7", messageId: 7, text: "Which format?\nYour words: brief", keyboard: keyboard.slice(0, 1) });
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({ chat_id: "7", message_id: 7, text: "Which format?\nYour words: brief", reply_markup: { inline_keyboard: [[{ text: "Summary", callback_data: "n:q0:o0" }]] } });
    // bounds: no empty rows, at most 3 per row and 12 rows, 64-byte data, and never both button shapes at once
    await expect(transport.sendMessage({ chatId: "7", text: "x", keyboard: [] })).rejects.toMatchObject({ code: "invalid-request" });
    await expect(transport.sendMessage({ chatId: "7", text: "x", keyboard: [[{ text: "a", data: "1" }, { text: "b", data: "2" }, { text: "c", data: "3" }, { text: "d", data: "4" }]] })).rejects.toMatchObject({ code: "invalid-request" });
    await expect(transport.sendMessage({ chatId: "7", text: "x", keyboard: Array.from({ length: 13 }, () => [{ text: "a", data: "1" }]) })).rejects.toMatchObject({ code: "invalid-request" });
    await expect(transport.sendMessage({ chatId: "7", text: "x", keyboard: [[{ text: "a", data: "x".repeat(65) }]] })).rejects.toMatchObject({ code: "invalid-request" });
    await expect(transport.sendMessage({ chatId: "7", text: "x", keyboard: [[{ text: "a", data: "1" }]], buttons: [{ text: "b", data: "2" }] })).rejects.toMatchObject({ code: "invalid-request" });
    await expect(transport.editQuestionMessage({ chatId: "7", messageId: 7, text: "x", keyboard: [] })).rejects.toMatchObject({ code: "invalid-request" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("uses fixed HTTPS methods and preserves explicit offsets and ignored update IDs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ id: 123456, is_bot: true, username: "FixtureBot" }))
      .mockResolvedValueOnce(ok([{ update_id: 10, message: { text: "fixture" } }, { update_id: 11, edited_message: {} }]))
      .mockResolvedValueOnce(ok([]));
    const transport = new TelegramTransport({ token, fetch: fetcher });
    expect(await transport.getMe()).toEqual({ id: "123456", username: "FixtureBot" });
    expect(await transport.getUpdates({ offset: 10, limit: 5, timeoutSeconds: 25 })).toEqual([{ update_id: 10, message: { text: "fixture" } }, { update_id: 11 }]);
    await transport.getUpdates({ offset: 10 });
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${token}/getMe`);
    expect(fetcher.mock.calls[1][1]?.redirect).toBe("error");
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({ offset: 10, limit: 5, timeout: 25, allowed_updates: ["message", "callback_query"] });
    expect(JSON.parse(fetcher.mock.calls[2][1]!.body as string).offset).toBe(10);
    expect(JSON.stringify(transport)).not.toContain(token);
  });
  it("sends plain text to immutable numeric chat IDs with explicit topic/reply data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(ok({ message_id: 7, chat: { id: -1001234567890 } }));
    const result = await new TelegramTransport({ token, fetch: fetcher }).sendMessage({ chatId: "-1001234567890", text: "<b>plain text</b>", topicId: 2, replyToMessageId: 3 });
    expect(result).toEqual({ chatId: "-1001234567890", messageId: 7 });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ chat_id: "-1001234567890", text: "<b>plain text</b>", message_thread_id: 2, reply_parameters: { message_id: 3 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refuses invalid IDs, offsets, lengths and configuration without network calls", async () => {
    const fetcher = vi.fn<typeof fetch>(); const transport = new TelegramTransport({ token, fetch: fetcher });
    expect(() => new TelegramTransport({ token: "123:secret/../other" })).toThrow("configuration");
    await expect(transport.getUpdates({ offset: -1 })).rejects.toMatchObject({ code: "invalid-request" });
    await expect(transport.getUpdates({ timeoutSeconds: 26 })).rejects.toMatchObject({ code: "invalid-request" });
    for (const chatId of ["@username", "0", "01", "9007199254740992"]) await expect(transport.sendMessage({ chatId, text: "fixture" })).rejects.toMatchObject({ code: "invalid-request", uncertain: false });
    await expect(transport.sendMessage({ chatId: "1", text: "x".repeat(4097) })).rejects.toMatchObject({ code: "invalid-request" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[401, "auth", false], [403, "forbidden", false], [409, "conflict", false], [429, "rate-limit", false], [500, "unavailable", true]] as const)("classifies %s without leaking provider diagnostics or retrying", async (status, code, uncertain) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, error_code: status, description: `secret ${token}`, parameters: { retry_after: 12 } }, { status }));
    const error = await new TelegramTransport({ token, fetch: fetcher }).sendMessage({ chatId: "1", text: "fixture" }).catch(error => error);
    expect(error).toMatchObject({ code, status, uncertain, retryAfterSeconds: 12 });
    expect(error.message + JSON.stringify(error)).not.toContain(token); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("marks malformed or mismatched successful-send responses uncertain", async () => {
    for (const response of [new Response("malformed"), ok({ message_id: 1, chat: { id: 2 } }), ok({})]) {
      const transport = new TelegramTransport({ token, fetch: vi.fn<typeof fetch>().mockResolvedValue(response) });
      await expect(transport.sendMessage({ chatId: "1", text: "fixture" })).rejects.toMatchObject({ code: "invalid-response", uncertain: true });
    }
  });
  it("cancels oversized streamed responses and rejects malformed update IDs", async () => {
    const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel });
    await expect(new TelegramTransport({ token, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) }).getMe()).rejects.toMatchObject({ code: "invalid-response" });
    expect(cancel).toHaveBeenCalled();
    await expect(new TelegramTransport({ token, fetch: vi.fn<typeof fetch>().mockResolvedValue(ok([{ update_id: Number.MAX_SAFE_INTEGER + 1 }])) }).getUpdates()).rejects.toMatchObject({ code: "invalid-response" });
  });
  it("covers response-body timeout and external abort with honest send uncertainty", async () => {
    const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(new TelegramTransport({ token, timeoutMs: 20, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) }).sendMessage({ chatId: "1", text: "fixture" })).rejects.toMatchObject({ code: "timeout", uncertain: true });
    expect(cancel).toHaveBeenCalled();
    const controller = new AbortController(); const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = new TelegramTransport({ token, fetch: fetcher }).sendMessage({ chatId: "1", text: "fixture", signal: controller.signal });
    controller.abort(token); await expect(pending).rejects.toMatchObject({ code: "cancel", uncertain: true });
    await expect(new TelegramTransport({ token, fetch: fetcher }).sendMessage({ chatId: "1", text: "fixture", signal: controller.signal })).rejects.toMatchObject({ code: "cancel", uncertain: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never retries uncertain network failures or follows token-bearing redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(`Network failed at https://api.telegram.org/bot${token}/sendMessage`));
    const error = await new TelegramTransport({ token, fetch: fetcher }).sendMessage({ chatId: "1", text: "fixture" }).catch(error => error);
    expect(error).toMatchObject({ code: "offline", uncertain: true }); expect(error.message).not.toContain(token);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
  });
});
