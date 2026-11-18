// Run from the repository root: node src/components/fixtures/capture-learning-request.mjs
// Captures only the pure request builder from the fixed pre-disclosure commit.
// No current production module is imported. The default policy at that commit has empty guidance.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const base = 'e2aa9ce02717d1ec9d09f56dc80a26a26eff28b7';
const source = execFileSync('git', ['show', `${base}:server/memory/extract.ts`], { encoding: 'utf8' });
const policy = execFileSync('git', ['show', `${base}:server/memory/evolution-policy.ts`], { encoding: 'utf8' });
if (!policy.includes('extraction:{classificationGuidance:""}')) throw Error('Unexpected base policy');
const instruction = source.match(/^const instruction=(".*");$/m)?.[1];
const builder = source.match(/export function memoryExtractionMessages\(text:string,policy:MemoryEvolutionPolicy=DEFAULT_MEMORY_EVOLUTION_POLICY\)\{([\s\S]*?)\n\}/)?.[1];
if (!instruction || !builder) throw Error('Base builder not found');
const messages = runInNewContext(`const instruction=${instruction}; const text="Owner prefers daily reports."; const policy={extraction:{classificationGuidance:""}}; (function(){${builder}})()`);
writeFileSync('src/components/fixtures/learning-request.e2aa9ce.json', JSON.stringify({model:'flux-fast', messages, max_tokens:100, stream:false}, null, 2) + '\n');
