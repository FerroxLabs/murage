export function readLists(root?: string): { gate: Set<string>; soak: Set<string> };
export function check(root?: string): { problems: string[] };
export function select(options: { tier: string; os: string; shard?: string; skip?: string[] }, root?: string): { files: string[] };
