export function readLists(root?: string): { gate: Set<string>; soak: Set<string> };
export function check(root?: string): { problems: string[] };
export function select(options: { tier: string; os: string; shard?: string; skip?: string[]; config?: string }, root?: string): { files: string[] };
export function configOwnedFiles(root?: string): Map<string, string[]>;
export function configGateRunners(root?: string): Set<string>;
