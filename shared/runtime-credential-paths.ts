/** Runtime roots are supplied by their owners, once per process, never from turn history. */
export type RuntimeCredentialKind = "browser" | "tunnel" | "backup";
const roots: Partial<Record<RuntimeCredentialKind, string>> = {};
export const RUNTIME_CREDENTIAL_ENTRIES = {
  browser: ["browser-*.json", "browser-*.json.new-*", "native-host.json", "native-host.json.new-*"],
  tunnel: ["connector-*.token"],
  backup: ["ssh-??????/key", "*/*/ssh-??????/key"],
} as const;
export function setRuntimeCredentialRoot(kind: RuntimeCredentialKind, root: string | undefined): void {
  if (root) roots[kind] = root;
  else delete roots[kind];
}
export function runtimeCredentialPaths(): { root: string; entries: readonly string[] }[] {
  return Object.entries(roots).map(([kind, root]) => ({ root, entries: RUNTIME_CREDENTIAL_ENTRIES[kind as RuntimeCredentialKind] }));
}
