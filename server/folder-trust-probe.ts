// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The file calls a turn's folder-trust answer (index.ts folderTrustForTurn) makes, run once for their calls only, so trust-fs.ts can answer
// them off the serving thread (1.0.22 N3). One line per call family folderTrustForTurn reaches; a family missing here is read live, which
// is exactly what froze the app: folder-trust-probe.test.ts replays each one after the disk changed.
import { canonicalFolder, folderTrustKey, scanFolderTrustSources } from "./folder-trust.ts";
import { probeUpstreamTrustFs } from "./folder-trust-upstream-cache.ts";
import { managedDeskQualifies, managedWorkspaceAutoTrust, type ManagedWorkspaceTrustInput } from "./managed-workspace-trust.ts";

export function probeFolderTrustFs(cwd: string, fuigoHome: string | null, generation: 1 | 2, managed: ManagedWorkspaceTrustInput | null): void {
  const engineKey = folderTrustKey(cwd, { fuigoHome: fuigoHome ?? undefined }); // the key the engine uses: its worktree registry, then git
  folderTrustKey(cwd); // the folder's own git key
  // the saved-decision lookup resolves both keys from the CANONICAL folder: a symlink alias into a registry-managed worktree reaches the
  // registry only through it
  const folder = canonicalFolder(cwd);
  folderTrustKey(folder, { fuigoHome: fuigoHome ?? undefined }); folderTrustKey(folder);
  probeUpstreamTrustFs(fuigoHome, engineKey, generation); // the engine's trust file: identity stat and the ancestor keys of a warm entry
  const scan = scanFolderTrustSources(cwd, { fuigoHome, trustGeneration: generation, upstreamState: { trusted: false, declined: false } });
  if (managed) { managedWorkspaceAutoTrust(cwd, scan, managed); managedDeskQualifies(cwd, scan, managed); }
}
