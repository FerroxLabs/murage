// Target I/O and snapshot owner: skills lane. Delivery budgets: decision lane.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

export const SWITCH_LIMITS = Object.freeze({ content: 256 * 1024, metadata: 1024 * 1024,
  entries: 1024, revisions: 64, findings: 128, findingBytes: 64 * 1024, snapshot: 128 * 1024,
  depth: 32, deleteFiles: 128, deleteDepth: 8, deleteBytes: 8 * 1024 * 1024,
  ruleEvaluations: 256, analysisSteps: 1_000_000, scanCalls: 0, batch: 16 });

export class SkillSwitchLimit extends Error {
  readonly code = 'limit-exceeded';
  constructor() { super('This skill change exceeds the review limit. Nothing was changed.'); }
}

/** The sentinel is fetched from the descriptor, including when a file grows after stat. */
export function readSwitchFile(path: string, cap: number): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > cap) throw new SkillSwitchLimit();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > cap) throw new SkillSwitchLimit();
    const bytes = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, length);
      if (!n) break;
      length += n;
    }
    const after = fstatSync(fd);
    if (length > cap || after.size !== length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new SkillSwitchLimit();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}

export function checkSwitchDepth(value: unknown, depth = 0): void {
  if (depth > SWITCH_LIMITS.depth) throw new SkillSwitchLimit();
  if (value && typeof value === 'object') for (const child of Object.values(value)) checkSwitchDepth(child, depth + 1);
}

export function parseSwitchMetadata(path: string): unknown {
  const parsed: unknown = JSON.parse(readSwitchFile(path, SWITCH_LIMITS.metadata));
  checkSwitchDepth(parsed);
  return parsed;
}
