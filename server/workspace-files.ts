// Workspace discovery, bounded read and revision-conditioned write.
// K0 skeleton: routed and desktop-gated, answers 501 until R3-T1 (list,
// search, root) and F4-T1 (read, write, save-version) fill it in.
// Contract: shared/workspace-files.ts and docs/plans/0152-CONTRACTS.md.
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactScope } from "./artifacts.ts";
import type { Store } from "./store.ts";
import { WORKSPACE_FILE_ERROR_STATUS, WORKSPACE_FILES_ROUTE_PREFIX, type WorkspaceFileErrorBody } from "../shared/workspace-files.ts";
import { hiddenRoute, type DelegatedRequest, type DelegatedResult } from "./route-delegation.ts";

/** Server facts a lane may need. Adding a field is a one-line change to the
 * deps object in server/index.ts; routing itself never changes. */
export interface WorkspaceFilesDeps {
  dataDir: string;
  database: () => DatabaseSync;
  store: Store;
  /** Same scope resolver Files and register_artifact already use. */
  artifactScopes: () => ArtifactScope[];
}

export async function workspaceFilesRoute(request: DelegatedRequest, _deps: WorkspaceFilesDeps): Promise<DelegatedResult> {
  // U-04: desktop-only in 0.1.52. A remote or unproven caller learns nothing.
  if (!request.desktop) return hiddenRoute();
  if (request.path !== WORKSPACE_FILES_ROUTE_PREFIX && !request.path.startsWith(`${WORKSPACE_FILES_ROUTE_PREFIX}/`)) return hiddenRoute();
  const body: WorkspaceFileErrorBody = { error: "Workspace files are not available in this build.", code: "not-implemented" };
  return { status: WORKSPACE_FILE_ERROR_STATUS["not-implemented"], body };
}
