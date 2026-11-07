export type CardView = { id: string; botName: string; query: string; status: string; expiresAt: number; copy: string; nonce: string; digest: string;
  excerpts: { messageId: string; source: string; text: string }[] };
type State = { phase: "loading" | "open" | "closed" | "failed"; card: CardView | null | undefined; busy: boolean; note: "" | "roomShare.failed" };
/** Framework-independent lifecycle. The component subscribes; tests drive the same requests and timers. */
export function createRoomShareCardState(api: (path: string, init?: RequestInit) => Promise<unknown>, changed: (state: State) => void) {
  let value: State = { phase: "loading", card: undefined, busy: false, note: "" };
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = (patch: Partial<State>) => { if (live) { value = { ...value, ...patch }; changed(value); } };
  const settle = (card: CardView | null) => {
    clearTimeout(timer);
    if (card?.status === "pending" && card.expiresAt <= Date.now()) card = { ...card, status: "unavailable", excerpts: [] };
    update({ card, phase: card?.status === "pending" ? "open" : "closed" });
    if (live && card?.status === "pending") timer = setTimeout(() => settle({ ...card, status: "unavailable", excerpts: [] }), Math.min(card.expiresAt - Date.now(), 2_147_483_647));
  };
  return {
    get value() { return value; },
    async load(id: string) {
      update({ phase: "loading", card: undefined, note: "" });
      try { const body = await api(`/api/room-shares/${encodeURIComponent(id)}`) as { share: CardView | null }; if (live) settle(body.share); }
      catch (error) {
        if (error && typeof error === "object" && "status" in error && error.status === 404) settle(null);
        else update({ phase: "failed", note: "roomShare.failed" });
      }
    },
    async answer(action: "share" | "decline", keep: Set<string>) {
      const card = value.card;
      if (!card || value.phase !== "open" || value.busy) return;
      update({ busy: true, note: "" });
      try {
        const body = action === "share" ? { nonce: card.nonce, digest: card.digest, keep: [...keep] } : {};
        const result = await api(`/api/room-shares/${encodeURIComponent(card.id)}/${action}`, { method: "POST", body: JSON.stringify(body) }) as { status: string };
        if (live) settle({ ...card, status: result.status, excerpts: [] });
      } catch { update({ note: "roomShare.failed" }); }
      finally { update({ busy: false }); }
    },
    dispose() { live = false; clearTimeout(timer); },
  };
}
