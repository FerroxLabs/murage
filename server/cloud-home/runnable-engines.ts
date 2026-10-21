// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudHomeCopy } from "./copy.ts";

/** The one list of which engines a Cloud home can run. An engine is runnable only when
 * the launcher has an argv rule for it (deploy/cloud-home/murage-turn-launch.py ARGV_RULES)
 * AND the image installs it (deploy/cloud-home/build-image.sh engine manifest). Every other
 * engine is hidden on a home: never offered, then broken. runnable-engines.test.ts holds
 * this list to both files so it cannot drift. Driver kinds, as the registry names them. */
export const CLOUD_RUNNABLE_ENGINES = ["claudeAgent", "codex", "grokAgent", "kimiAgent", "opencodeGo", "fuigoAgent"] as const;
export const CLOUD_HIDDEN_ENGINES = ["piAgent", "hermesAgent", "geminiAgent", "cursorAgent", "antigravityAgent", "droidAgent", "qwenAgent", "customAcp"] as const;
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
