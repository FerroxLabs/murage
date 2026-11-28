// Settings v10 L0 (owner: core, C8): the client half of settingRef. A refusal body carries `settingRef` beside its message; this
// returns it only when it is well formed and its id is a control the manifest knows, so a link is never invented.
// `with { type: "json" }`: tsconfig.server.json (NodeNext) compiles this file through the server test, and a bare JSON import is TS1543 there.
import manifest from "./settings-controls.manifest.json" with { type: "json" };
import { SETTING_REF_KEY, type SettingRef } from "../../shared/setting-ref.ts";

let ids: Set<string> | undefined;
export function knownSettingIds(): Set<string> {
  ids ??= new Set<string>([...Object.values(manifest.appHomes as Record<string, string>), ...(manifest.simpleCards as string[]), ...Object.keys(manifest.bot).map((key) => `bot.${key}`)]);
  return ids;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined);

export function decodeSettingRef(body: unknown): SettingRef | null {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>)[SETTING_REF_KEY] : undefined;
  if (!raw || typeof raw !== "object") return null;
  const ref = raw as Record<string, unknown>;
  const id = text(ref.id);
  const code = text(ref.code);
  if (!id || !code || !knownSettingIds().has(id)) return null;
  const out: SettingRef = { id, code };
  for (const key of ["bot", "account", "device", "item"] as const) { const value = text(ref[key]); if (value) out[key] = value; }
  return out;
}
