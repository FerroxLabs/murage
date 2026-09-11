import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { RestoreReviewRequiredError } from "./restore-errors.mjs";

export const RESTORED_CONNECTIONS_FILE = "restored-connections.json";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Read only, after installation ownership. Never fall back to old connection
 * state when an existing marker is malformed or unreadable. */
export function restoredConnectionProfile(dataDir) {
  const file = path.join(dataDir, RESTORED_CONNECTIONS_FILE);
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw new RestoreReviewRequiredError(); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) throw new RestoreReviewRequiredError();
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new RestoreReviewRequiredError(); }
  if (!value || value.version !== 1 || typeof value.id !== "string" || !uuid.test(value.id) || Object.keys(value).some(key => key !== "version" && key !== "id")) throw new RestoreReviewRequiredError();
  const directory = path.join(dataDir, "connection-profiles", value.id);
  return Object.freeze({ id: value.id, directory, credentialsFile: path.join(directory, "credentials.bin"), companionSettings: path.join(directory, "desktop"), companionState: path.join(directory, "companion"), tunnelRuntime: path.join(directory, "managed-tunnel") });
}

/** Murage connection credentials, not native provider/Fuigo inheritance. */
export function restoredHarnessEnvironment(environment, profile) {
  const result = { ...environment };
  if (profile) for (const key of ["COMPOSIO_API_KEY", "MURAGE_COMPOSIO_BROKER_URL", "MURAGE_COMPOSIO_BROKER_TOKEN", "MURAGE_FLUX_COMPOSIO_BROKER_URL", "MURAGE_FLUX_COMPOSIO_BROKER_TOKEN", "MURAGE_FLUX_COMPOSIO_ACCOUNT_KIND", "MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL", "MURAGE_COMPOSIO_LEGACY_CLAIM", "MURAGE_COMPANION_HOSTED_URL", "MURAGE_COMPANION_DIR", "MURAGE_BROWSER_CONNECTION"]) delete result[key];
  return result;
}

/** Preserve browser labels/IDs while selecting fresh durable cookie storage.
 * Temporary guest partitions remain temporary. No old partition is erased. */
export function restoredBrowserPartition(partition, profile) {
  if (!profile || !partition.startsWith("persist:")) return partition;
  return "persist:restored-" + profile.id + "-" + partition.slice("persist:".length);
}
