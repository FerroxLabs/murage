/** Exact probe evidence, DESIGN-NATIVE-DENY-1020-r2 §§1, 2.2, 7.
 * No version ordering and no substitute evidence from environment variables.
 */
export const OPERATION_CLASSES = Object.freeze([
  "shell", "shell-indirect", "stdin", "write", "read", "search", "mcp-owner", "mcp-murage",
  "subagent", "disabled-tool", "hosted", "alias", "failure", "wipe",
] as const);
export type OperationClass = typeof OPERATION_CLASSES[number];
export type ProbePlatform = "linux" | "darwin" | "win32";
export type Transport = "stream-json" | "app-server" | "exec" | "acp" | "in-process";
export type ShellMode = "murage-exec" | "powershell-inherit" | "n/a";
export interface ProbeRevisions {
  /** Git blob hashes of the emitted artifact set and backstop, derived by the server. */
  emitterRev: string;
  backstopRev: string;
  probeSetRev: string;
  /** Hashes of every enforcement dependency (aggregate canonical manifests when multi-file).
   * configRev covers the effective policy, DenySpec, refusals and mount configuration.
   * Integration derives these from trusted artifacts/settings, never a client claim.
   */
  readerRev: string;
  adapterRev: string;
  clientRev: string;
  protocolRev: string;
  integrityRev: string;
  configRev: string;
}
export interface ProbeTuple extends ProbeRevisions {
  engine: string;
  version: string;
  binarySha256: string;
  platform: NodeJS.Platform;
  arch: string;
  osMajor: string;
  transport: Transport;
  shellMode: ShellMode;
}
export interface ProbeRow extends ProbeTuple {
  classes: Record<OperationClass, "pass">;
  box: string;
  date: string;
  log: string;
  revoked?: true;
}
const HASH_REVISION_KEYS = ["emitterRev", "backstopRev", "readerRev", "adapterRev", "clientRev", "protocolRev", "integrityRev", "configRev"] as const;
const REVISION_KEYS = [...HASH_REVISION_KEYS, "probeSetRev"] as const;
const TUPLE_KEYS = ["engine", "version", "binarySha256", "platform", "arch", "osMajor", "transport", "shellMode",
  ...REVISION_KEYS] as const;
// Binary hashes, OS major and architecture legitimately differ on other gate boxes.
const GATE_KEYS = ["engine", "version", "transport", "shellMode", ...REVISION_KEYS] as const;
const GATE_PLATFORMS: readonly ProbePlatform[] = ["linux", "darwin", "win32"];

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
export function validRevisions(value: unknown): value is ProbeRevisions {
  return record(value) && HASH_REVISION_KEYS.every(key => typeof value[key] === "string"
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value[key])) && nonempty(value.probeSetRev);
}
export function validLaunchMode(value: unknown): value is { transport: Transport; shellMode: ShellMode } {
  return record(value) && ["stream-json", "app-server", "exec", "acp", "in-process"].includes(value.transport as string)
    && ["murage-exec", "powershell-inherit", "n/a"].includes(value.shellMode as string);
}
export function validBuild(value: unknown): value is { version: string; binarySha256: string } {
  return record(value) && nonempty(value.version) && typeof value.binarySha256 === "string" && /^[a-f0-9]{64}$/.test(value.binarySha256);
}
function validTuple(value: unknown): value is ProbeTuple {
  if (!record(value)) return false;
  const { engine, platform, arch, osMajor } = value;
  return nonempty(engine) && GATE_PLATFORMS.includes(platform as ProbePlatform) && nonempty(arch)
    && typeof osMajor === "string" && /^(?:0|[1-9][0-9]*)$/.test(osMajor)
    && validBuild(value) && validRevisions(value) && validLaunchMode(value);
}
function validRow(value: unknown): value is ProbeRow {
  if (!validTuple(value) || !record(value)) return false;
  if (value.revoked !== undefined && value.revoked !== true) return false;
  // A red/incomplete row cannot serve as evidence. Unreachable classes need proof too;
  // until a reviewed n/a representation exists, they conservatively prevent switching.
  const classes = value.classes;
  if (!record(classes) || !OPERATION_CLASSES.every(c => classes[c] === "pass")) return false;
  return nonempty(value.box) && nonempty(value.log) && typeof value.date === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value.date) && Number.isFinite(Date.parse(value.date))
    && new Date(value.date).toISOString().slice(0, 10) === value.date;
}
function sameFields(row: ProbeTuple, tuple: ProbeTuple, keys: readonly (keyof ProbeTuple)[]): boolean {
  return keys.every(key => row[key] === tuple[key]);
}
/** Production supplies only the imported, reviewed JSON. Exported pure matcher permits fake tests.
 * Fail closed on malformed evidence, ambiguous duplicate tuples, or a missing three-OS gate.
 */
export function matchProbeRegistry(rows: unknown, tuple: ProbeTuple): boolean {
  try {
    if (!validTuple(tuple) || !Array.isArray(rows) || !rows.every(validRow)) return false;
    // Reject every duplicate before choosing OS witnesses; an alternative witness must
    // never hide a revoked or ambiguous duplicate for the same tuple.
    const identities = rows.map(row => JSON.stringify(TUPLE_KEYS.map(key => row[key])));
    if (new Set(identities).size !== rows.length) return false;
    const exact = rows.filter(row => sameFields(row, tuple, TUPLE_KEYS));
    if (exact.length !== 1 || exact[0]!.revoked === true) return false;
    return GATE_PLATFORMS.every(platform => rows.some(row => {
      if (row.platform !== platform || row.revoked === true || !sameFields(row, tuple, GATE_KEYS)) return false;
      return true;
    }));
  } catch {
    return false;
  }
}
