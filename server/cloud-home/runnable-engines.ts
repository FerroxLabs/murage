// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudHomeCopy } from "./copy.ts";

/** The one list of which engines a Cloud home can run. An engine is runnable only when
 * the launcher has an argv rule for it (deploy/cloud-home/murage-turn-launch.py ARGV_RULES)
 * AND the image installs it (deploy/cloud-home/build-image.sh engine manifest). Every other
 * engine is hidden on a home: never offered, then broken. runnable-engines.test.ts holds
 * this list to both files so it cannot drift. Driver kinds, as the registry names them. */
export const CLOUD_RUNNABLE_ENGINES = ["claudeAgent", "codex", "antigravityAgent", "grokAgent", "kimiAgent", "opencodeGo", "fuigoAgent"] as const;
export const CLOUD_HIDDEN_ENGINES = ["piAgent", "hermesAgent", "geminiAgent", "cursorAgent", "droidAgent", "qwenAgent", "customAcp", "museCode"] as const;
/** Hidden engines the home launcher does not know at all (no turn-process.ts CLOUD_ENGINES
 * row). Muse Code is desktop only until counsel or Meta answers whether a Ferrox-run
 * machine may hold a tenant's Muse install and key (ledger row GAP-MUSE-CLOUD). */
export const CLOUD_DESKTOP_ONLY_ENGINES = ["museCode"] as const;
/** Engines that run only on the person's own computer and are not cloud engines at all
 * (turn-process.ts CLOUD_ENGINES has no entry, so a turn there could only fail). A home
 * leaves them out of its engine list like the hidden ones, and the picker shows one line
 * for each instead of a pickable engine (cloudLocalOnlyEngineNames). Kept apart from
 * CLOUD_HIDDEN_ENGINES so that list still matches CLOUD_ENGINES exactly; the launcher and
 * the image are untouched. Driver kind to the engine's own name. */
export const CLOUD_LOCAL_ONLY_ENGINES = { clineAgent: "Cline", copilotAgent: "GitHub Copilot" } as const;
function isCloudLocalOnlyEngine(driver: string): boolean {
  return Object.hasOwn(CLOUD_LOCAL_ONLY_ENGINES, driver);
}
/** True for a driver kind a home has no way to run. Other kinds (the hosted-model and
 * computer drivers) do not start an engine process and are not listed here. */
export function isCloudHiddenEngine(driver: string | undefined): boolean {
  return (CLOUD_HIDDEN_ENGINES as readonly string[]).includes(driver ?? "") || isCloudLocalOnlyEngine(driver ?? "") || (CLOUD_WITHHELD_ENGINES as readonly string[]).includes(driver ?? "");
}
/** Engines the image installs but a home does not offer yet: Antigravity first sign-in has no code box on a Cloud
 * window, so it stays hidden here (desktop unchanged) until that ships. Kept apart so the launcher and image lists stay exact. */
export const CLOUD_WITHHELD_ENGINES = ["antigravityAgent"] as const;
/** The plain line for an engine a home hides: its own words for a withheld one, the general line otherwise. */
export function cloudHiddenEngineLine(driver: string | undefined): string {
  return (CLOUD_WITHHELD_ENGINES as readonly string[]).includes(driver ?? "") ? cloudHomeCopy.antigravityNotOnCloud : cloudHomeCopy.engineNotOnCloud;
}
/** The names of the local-only engines in this fleet, once each, in fleet order. A home sends
 * them with its engine list so the picker can say where they run (the desktop sends none). */
export function cloudLocalOnlyEngineNames(drivers: Iterable<string | undefined>): string[] {
  const names: string[] = [];
  for (const driver of drivers) {
    if (!driver || !isCloudLocalOnlyEngine(driver)) continue;
    const name = CLOUD_LOCAL_ONLY_ENGINES[driver as keyof typeof CLOUD_LOCAL_ONLY_ENGINES];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
/** The refusal for creating a bot on, or switching one to, an engine a Cloud home hides (the
 * picker never offers it; this is the second wall). `driver` is the engine's configured
 * driver kind, `changing` is false when a bot keeps the engine it already has. */
export function cloudEngineChoiceRefusal(onCloudHome: boolean, driver: string | undefined, changing: boolean): string | undefined {
  return onCloudHome && changing && isCloudHiddenEngine(driver) ? cloudHiddenEngineLine(driver) : undefined;
}

/** Engines a home runs but offers only to a desktop that can sign them in. Antigravity's sign-in needs
 * the desktop's Google link and code box (1.0.4 and later), so the renderer says so with a capability
 * flag (never a version string): `x-murage-client-capabilities: antigravity-signin`. No flag, no engine. */
export const CLOUD_CLIENT_GATED_ENGINES: Readonly<Record<string, string>> = { antigravityAgent: "antigravity-signin" };
export const CLIENT_CAPABILITIES_HEADER = "x-murage-client-capabilities";
/** The flags a request's header names (comma separated, lower case, bounded). */
export function parseClientCapabilities(header: string | string[] | undefined): ReadonlySet<string> {
  const text = Array.isArray(header) ? header.join(",") : header ?? "";
  return new Set(text.slice(0, 512).split(",").map(part => part.trim().toLowerCase()).filter(part => /^[a-z0-9-]{1,48}$/.test(part)).slice(0, 32));
}
/** True for a gated engine the calling client cannot sign in. Fails closed: an unknown caller has no flags. */
export function isCloudEngineWithheldFromClient(onCloudHome: boolean, driver: string | undefined, capabilities: ReadonlySet<string> | undefined): boolean {
  const needed = onCloudHome && driver ? CLOUD_CLIENT_GATED_ENGINES[driver] : undefined;
  return needed !== undefined && !capabilities?.has(needed);
}
/** The refusal for choosing a gated engine from a client without its flag (the picker never offers it). */
export function cloudEngineClientRefusal(onCloudHome: boolean, driver: string | undefined, capabilities: ReadonlySet<string> | undefined): string | undefined {
  return isCloudEngineWithheldFromClient(onCloudHome, driver, capabilities) ? cloudHomeCopy.updateMurageForAntigravity : undefined;
}
