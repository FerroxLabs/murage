// C6 · owner: roster (producer: server/settings/archive-guard.ts) → core (consumer: seated bot PATCH hook).
export type ArchiveGuardResult = { ok: true } | { ok: false; status: 409; body: { error: string; code: "ACCESS_CHANGED"; botId: string } };
