export type RebaseResult = { keep: true } | { path: string } | { refused: true };
export type Constructors = (root: string) => Array<string | undefined>;
export function lexicalKey(path: string, platform: string): string | undefined;
export function rebaseStoredPath(stored: string, constructors: Constructors, context: { dataDir: string; previous?: readonly string[]; platform: string }): RebaseResult;
