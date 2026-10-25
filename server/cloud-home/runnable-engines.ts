// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudHomeCopy } from "./copy.ts";

/** The one list of which engines a Cloud home can run. An engine is runnable only when
 * the launcher has an argv rule for it (deploy/cloud-home/murage-turn-launch.py ARGV_RULES)
 * AND the image installs it (deploy/cloud-home/build-image.sh engine manifest). Every other
 * engine is hidden on a home: never offered, then broken. runnable-engines.test.ts holds
 * this list to both files so it cannot drift. Driver kinds, as the registry names them. */
export const CLOUD_RUNNABLE_ENGINES = ["claudeAgent", "codex", "antigravityAgent", "grokAgent", "kimiAgent", "opencodeGo", "fuigoAgent"] as const;
export const CLOUD_HIDDEN_ENGINES = ["piAgent", "hermesAgent", "geminiAgent", "cursorAgent", "droidAgent", "qwenAgent", "customAcp"] as const;
/** True for a driver kind a home has no way to run. Other kinds (the hosted-model and
 * computer drivers) do not start an engine process and are not listed here. */
export function isCloudHiddenEngine(driver: string | undefined): boolean {
  return (CLOUD_HIDDEN_ENGINES as readonly string[]).includes(driver ?? "");
}
/** The refusal for creating a bot on, or switching one to, an engine a Cloud home hides (the
 * picker never offers it; this is the second wall). `driver` is the engine's configured
 * driver kind, `changing` is false when a bot keeps the engine it already has. */
export function cloudEngineChoiceRefusal(onCloudHome: boolean, driver: string | undefined, changing: boolean): string | undefined {
  return onCloudHome && changing && isCloudHiddenEngine(driver) ? cloudHomeCopy.engineNotOnCloud : undefined;
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
