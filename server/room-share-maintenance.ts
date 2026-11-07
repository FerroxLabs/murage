import { ROOM_SHARE_PRUNE_BATCH } from "./room-shares.ts";
// Each callback owns one short batch; no writer gate spans a yield.
export function startRoomShareMaintenance(
  prune: () => number | null,
  guard: (name: string, run: () => unknown) => () => Promise<void>,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (delay: number) => {
    if (!stopped) { timer = setTimeout(tick, delay); timer.unref?.(); }
  };
  const tick = async () => {
    let count: number | null = null;
    try { await guard("room-share-prune", () => { if (!stopped) count = prune(); })(); }
    finally { schedule(count === null ? 1000 : count === ROOM_SHARE_PRUNE_BATCH ? 1 : 86_400_000); }
  };
  schedule(1);
  return () => { stopped = true; clearTimeout(timer); };
}
