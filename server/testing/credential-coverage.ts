import { DATA_CREDENTIAL_ENTRIES, dataCredentialHit } from "../../shared/data-credential-paths.ts";
import { credentialGlobHit, globKeyRead } from "../../shared/sensitive-globs.ts";
import { SENSITIVE_PATHS } from "../../shared/sensitive-paths.ts";
import { RUNTIME_CREDENTIAL_ENTRIES } from "../../shared/runtime-credential-paths.ts";

export type CoverageCase = {
  platform: NodeJS.Platform; root: string; path: string; cover: string;
  branch?: string; reason?: string; glob?: string;
};
const exemptions = new Set(["ordinary-content", "logs", "history", "noncredential-state"]);

/** Validate the declared rule itself, not just any rule that happens to match. */
export function checkCoverageCase(row: CoverageCase, location: string): void {
  if (!["linux", "darwin", "win32"].includes(row.platform)) throw new Error(`${location}: unknown platform`);
  if (!row.path.startsWith(row.root + "/")) throw new Error(`${location}: path outside root`);
  const options = { platform: row.platform, roots: { temp: [], data: [row.root] } };
  if (row.cover.startsWith("exempt:")) {
    if (!exemptions.has(row.cover.slice(7)) || !row.reason?.trim()) throw new Error(`${location}: unknown exemption or missing reason`);
    if (dataCredentialHit([row.path], [row.root]) || SENSITIVE_PATHS.some(rule => rule.re.test(row.path))) throw new Error(`${location}: exemption is sensitive: ${row.path}`);
    if (credentialGlobHit([row.glob ?? row.path], options) || globKeyRead(row.glob ?? row.path, row.platform)) throw new Error(`${location}: exemption glob is sensitive: ${row.path}`);
    return;
  }
  if (row.cover.startsWith("rule:")) {
    const rule = SENSITIVE_PATHS.find(rule => rule.id === row.cover.slice(5));
    if (!rule) throw new Error(`${location}: unknown cover ${row.cover}`);
    if (!rule.re.test(row.path)) throw new Error(`${location}: literal not covered: ${row.path}`);
    if (!globKeyRead(row.glob ?? row.path + "*", row.platform)) throw new Error(`${location}: glob not covered: ${row.path}`);
    return;
  }
  const runtime = row.cover.startsWith("runtime:browser:");
  const entry = runtime ? row.cover.slice("runtime:browser:".length) : row.cover;
  const entries: readonly string[] = runtime ? RUNTIME_CREDENTIAL_ENTRIES.browser : DATA_CREDENTIAL_ENTRIES;
  if (!entries.includes(entry)) throw new Error(`${location}: unknown cover ${row.cover}`);
  if (!dataCredentialHit([row.path], [row.root], [entry])) throw new Error(`${location}: literal not covered: ${row.path}`);
  if (!credentialGlobHit([row.glob ?? row.path + "*"], { ...options, ...(runtime ? { runtime: [{ root: row.root, entries: [entry] }] } : {}) })) throw new Error(`${location}: glob not covered: ${row.path}`);
}
export function credentialCoverage(source: string): { source: string; cases: CoverageCase[] }[] {
  return source.split("\n").filter(line => /^[^ |]+:\d+ \| [ABC] \| /.test(line)).map(line => {
    const [location] = line.split(" | ");
    const marker = line.indexOf(" | coverage=");
    if (marker < 0) throw new Error(`${location}: missing coverage`);
    const cases = JSON.parse(line.slice(marker + " | coverage=".length)) as CoverageCase[];
    if (!Array.isArray(cases) || !cases.length) throw new Error(`${location}: empty coverage`);
    for (const row of cases) checkCoverageCase(row, location!);
    return { source: location!, cases };
  });
}
