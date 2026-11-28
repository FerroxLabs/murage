// TEACH-ENTRY 1.0.23 D6: "Taught by you". Lists the recordings in <DATA_DIR>/skills and changes
// who can use one (the manifest's `bots`). Reads each manifest directly: loadUserSkills drops a
// damaged folder silently, and a damaged one must still be listed (F6). Desktop only.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { manifestBots, parseSkillManifest } from "./skill-library.ts";

export interface TaughtSkillRow {
  id: string;
  name?: string;
  description?: string;
  bots?: string[];
  botNames?: string[];
  missingBots?: number;
  damaged?: true;
}
export interface TaughtDeps {
  root: string;
  bots: () => Array<{ id: string; name: string }>;
  /** The parsed JSON body (server/read-body.ts). */
  readBody: () => Promise<unknown>;
  /** Test seam for F7: the atomic rename that replaces the manifest. */
  rename?: (from: string, to: string) => void;
}
type Answer = { status: number; body: unknown } | null;

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TAUGHT_PATH = "/api/skills/taught";

export function listTaughtSkills(deps: Pick<TaughtDeps, "root" | "bots">): TaughtSkillRow[] {
  if (!existsSync(deps.root)) return [];
  const names = new Map(deps.bots().map((bot) => [bot.id, bot.name]));
  const rows: TaughtSkillRow[] = [];
  let folders: string[] = [];
  try { folders = readdirSync(deps.root).sort(); } catch { return []; }
  for (const folder of folders) {
    const directory = join(deps.root, folder);
    const manifestPath = join(directory, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = parseSkillManifest(JSON.parse(readFileSync(manifestPath, "utf8")), directory);
      const known = (manifest.bots ?? []).filter((id) => names.has(id));
      rows.push({
        id: manifest.id, name: manifest.name, description: manifest.description,
        ...(manifest.bots ? { bots: manifest.bots } : {}),
        botNames: known.map((id) => names.get(id)!),
        missingBots: (manifest.bots?.length ?? 0) - known.length,
      });
    } catch {
      rows.push({ id: folder, damaged: true });
    }
  }
  return rows;
}

/** GET /api/skills/taught and PATCH /api/skills/taught/:id; null for any other path (matched before /api/skills/:ref). */
export async function handleTaughtSkills(method: string, path: string, deps: TaughtDeps): Promise<Answer> {
  if (path === TAUGHT_PATH) {
    if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };
    return { status: 200, body: { skills: listTaughtSkills(deps) } };
  }
  if (!path.startsWith(`${TAUGHT_PATH}/`)) return null;
  if (method !== "PATCH") return { status: 405, body: { error: "method not allowed" } };
  let id = "";
  try { id = decodeURIComponent(path.slice(TAUGHT_PATH.length + 1)); } catch { return { status: 404, body: { error: "no such taught skill" } }; }
  const manifestPath = join(deps.root, id, "manifest.json");
  if (!SAFE_ID.test(id) || !existsSync(manifestPath)) return { status: 404, body: { error: "no such taught skill" } };
  let body: unknown;
  try { body = await deps.readBody(); } catch { return { status: 400, body: { error: "Choose bots that exist." } }; }
  const wanted = (body as { bots?: unknown } | null)?.bots;
  const bots = wanted === null ? undefined : manifestBots(wanted);
  if (wanted === undefined || bots === null) return { status: 400, body: { error: "Choose bots that exist." } };
  const existing = new Set(deps.bots().map((bot) => bot.id));
  if (bots && !bots.every((botId) => existing.has(botId))) return { status: 400, body: { error: "Choose bots that exist." } };
  const temporary = join(deps.root, id, `.manifest-${randomUUID()}.json`);
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    parseSkillManifest(raw, join(deps.root, id));
    const next = { ...raw };
    if (bots) next.bots = bots; else delete next.bots;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    (deps.rename ?? renameSync)(temporary, manifestPath);
  } catch {
    rmSync(temporary, { force: true });
    return { status: 500, body: { error: "Could not save who can use this skill. Nothing changed." } };
  }
  return { status: 200, body: { skills: listTaughtSkills(deps) } };
}
