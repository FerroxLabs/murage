// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The verified-install idea follows OpenMausBot's engine setup (Apache-2.0), see NOTICE.
import { homeMeta } from "./cloud-home-meta";

/** The in-app Terminal button needs the desktop bridge, and a Cloud home has no
 *  terminal of the person's own to open: the page carries a home id there. */
export function canOpenSetupTerminal(
  bridge: { openEngineSetupTerminal?: unknown } | undefined,
  doc: Pick<Document, "querySelector"> | undefined,
): boolean {
  if (!bridge?.openEngineSetupTerminal) return false;
  if (doc && homeMeta(doc).homeId) return false;
  return true;
}

export interface CheckedEngine {
  displayName: string;
  snapshot: { state: "available" | "unavailable"; authenticated?: boolean; version?: string | null; reason?: string };
}

/** What "Check again" says. After an install command was started from this card,
 *  a found CLI is confirmed by name and version, and one still not found says so
 *  with the engine's own reason, so the person is never left guessing. */
export function checkAgainMessage(engine: CheckedEngine, options: { signInOnly: boolean; installStarted: boolean; cloudIntent: boolean }): string {
  const { snapshot, displayName } = engine;
  if (snapshot.state !== "available") {
    const reason = snapshot.reason ?? "The engine is not detected yet. Finish setup and check again.";
    return options.installStarted ? `${displayName} is still not detected after the install. ${reason}` : reason;
  }
  const needsSignIn = snapshot.authenticated === false && options.cloudIntent;
  if (needsSignIn) return "Engine detected. Finish sign-in, then check again.";
  if (options.installStarted && !options.signInOnly) {
    return snapshot.version ? `${displayName} is installed (${snapshot.version}). Select a model to test it with a task.` : `${displayName} is installed. Select a model to test it with a task.`;
  }
  return "Engine detected. Select a model to test it with a task.";
}
