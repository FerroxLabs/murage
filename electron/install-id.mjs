// A random per-install id, made once and kept, used only to tell this install's
// connected-apps tokens apart from another device's at Flux. Never derived from
// the user's name, the computer's name or any key.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "install-id.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const memory = new Map();

export function getInstallId(dir) {
  if (memory.has(dir)) return memory.get(dir);
  let id;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
    if (typeof parsed?.installId === "string" && UUID.test(parsed.installId)) id = parsed.installId;
  } catch {
    // none yet, or damaged: make one
  }
  if (!id) {
    id = randomUUID();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, FILE), JSON.stringify({ installId: id }), { mode: 0o600 });
    } catch {
      // unwritable: this launch still has a stable id in memory
    }
  }
  memory.set(dir, id);
  return id;
}

/** The label sent when minting a connected-apps token. */
export function mintLabel(dir) {
  return `murage-${getInstallId(dir)}`;
}
