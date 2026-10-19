// SPDX-License-Identifier: AGPL-3.0-or-later
export interface WorkspaceCredentialField {
  section: string;
  field: string;
  name: string;
  env: string;
}
export const WORKSPACE_CREDENTIALS: readonly WorkspaceCredentialField[];
export function migrateWorkspaceCredentials(
  config: Record<string, unknown>,
  credentials: Record<string, string>,
): {
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  configChanged: boolean;
  credentialsChanged: boolean;
};
export function workspaceCredentialEnv(credentials: Record<string, string>): Record<string, string>;
