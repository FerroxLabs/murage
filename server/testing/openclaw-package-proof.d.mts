export function loadOpenclawPackage(root: string): {
  packageVersion: string;
  files: Record<string, string>;
  applySessionExecutionSettings(entry: Record<string, unknown>, patch: Record<string, unknown>): void;
  resolveSessionPermissionExecPolicy(policy: { mode: unknown }, overrides: { security: unknown; ask: unknown }): Record<string, unknown>;
  extractExecDirective(text: string): { execSecurity: string; execAsk: string; [key: string]: unknown };
  requiresExecApproval(policy: { security: string; ask: string }): boolean;
};
