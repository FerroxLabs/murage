import { afterEach, expect, it, vi } from "vitest";
import { createRoomShareCardState, type CardView } from "./room-share-card-state";
afterEach(() => vi.useRealTimers());
const card: CardView = { id: "draft", botName: "Bot", query: "query", status: "pending", expiresAt: 1000, copy: "", nonce: "n", digest: "d", excerpts: [{ messageId: "m", source: "source", text: "private" }] };
it("loads the actual request and closes a missing receipt without an outcome", async () => {
  const api = vi.fn().mockRejectedValue({ status: 404 });
  const changed = vi.fn();
  const state = createRoomShareCardState(api, changed);
  expect(state.value.phase).toBe("loading");
  await state.load("gone");
  expect(api).toHaveBeenCalledWith("/api/room-shares/gone");
  expect(state.value).toMatchObject({ phase: "closed", card: null, note: "" });
  expect(changed).toHaveBeenLastCalledWith(state.value);
  expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2); state.dispose();
});
it.each([new Error("offline"), { status: 500 }, { status: 403 }])("a rejected fetch is failure, not closed", async error => {
  const changed = vi.fn();
  const state = createRoomShareCardState(vi.fn().mockRejectedValue(error), changed);
  await state.load("bad"); expect(state.value.phase).toBe("failed"); expect(state.value.note).toBe("roomShare.failed"); expect(changed).toHaveBeenLastCalledWith(state.value);
  expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2); state.dispose();
});
it("expires a pending preview with a real timer and clears its excerpts", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const changed = vi.fn();
  const state = createRoomShareCardState(vi.fn().mockResolvedValue({ share: card }), changed);
  await state.load("draft"); expect(state.value.phase).toBe("open");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "open" }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(state.value.phase).toBe("closed"); expect(state.value.card?.excerpts).toEqual([]); expect(changed).toHaveBeenLastCalledWith(state.value);
  expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2); state.dispose();
});
it("a failed action clears busy and preserves the pending card for retry", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const api = vi.fn().mockResolvedValueOnce({ share: card }).mockRejectedValueOnce(new Error("failed"));
  const changed = vi.fn();
  const state = createRoomShareCardState(api, changed);
  await state.load("draft"); const action = state.answer("share", new Set(["m"]));
  expect(state.value.busy).toBe(true); expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ busy: true })); await action;
  expect(api).toHaveBeenLastCalledWith("/api/room-shares/draft/share", { method: "POST", body: JSON.stringify({ nonce: "n", digest: "d", keep: ["m"] }) });
  expect(state.value).toMatchObject({ busy: false, phase: "open", note: "roomShare.failed" }); expect(changed).toHaveBeenLastCalledWith(state.value);
  expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2); state.dispose();
});
