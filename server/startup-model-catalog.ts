import { decodeChoices, ACP_OPTION_LIMIT } from "./drivers/acp/config-options.ts";
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { writeFileAtomic } from './atomic.ts';
import type { ModelCatalog } from './contracts.ts';

// Instance, command and environment all define the account whose catalog this is.
export function startupCatalogPath(identity: unknown): string {
  return join(DATA_DIR, 'model-catalogs', createHash('sha256').update(JSON.stringify(identity)).digest('hex') + '.json');
}
export function readStartupModelCatalog(path: string): ModelCatalog | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    // Discovery may prepend one Murage-owned passthrough model to 128 native models.
    const valid = (choices: unknown, limit = ACP_OPTION_LIMIT) => Array.isArray(choices) && choices.length <= limit
      && decodeChoices(choices, limit).length === choices.length;
    if (!valid(value.options, ACP_OPTION_LIMIT + 1) || !value.options.length || !value.options.some((m: any) => m.id === value.default)
      || !value.options.every((m: any) => m.variants === undefined || valid(m.variants))) {
      rmSync(path, { force: true });
      return;
    }
    return { ...value, source: 'static' };
  } catch { try { rmSync(path, { force: true }); } catch {} return; }
}
export function writeStartupModelCatalog(path: string, catalog: ModelCatalog): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, JSON.stringify(catalog), { mode: 0o600 });
}
