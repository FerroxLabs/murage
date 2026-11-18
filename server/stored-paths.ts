// S5: one lexical rule for stored paths on the server and desktop. No stored path is read or followed.
import { DATA_DIR } from "./config.ts";
import { dataRoots } from "./data-roots.ts";
import { lexicalKey as key, rebaseStoredPath as rebase } from "../shared/stored-root-path.mjs";
export type { RebaseResult, Constructors } from "../shared/stored-root-path.mjs";
import type { RebaseResult, Constructors } from "../shared/stored-root-path.mjs";
export interface RebaseContext { dataDir?: string; previous?: string[]; platform?: NodeJS.Platform }
export function lexicalKey(path: string, platform: NodeJS.Platform = process.platform): string | undefined { return key(path, platform); }
export function rebaseStoredPath(stored: string, constructors: Constructors, context: RebaseContext = {}): RebaseResult {
  return rebase(stored, constructors, { dataDir: context.dataDir ?? DATA_DIR, previous: context.previous ?? dataRoots().previousRoots(), platform: context.platform ?? process.platform });
}
