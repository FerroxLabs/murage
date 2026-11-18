// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LineCounter, parseDocument } from 'yaml';
import { budgets, checkPeak, root } from './typecheck-budget.mjs';

// Resolve package scripts, workspace filters and test/package indirection. Keep
// the chain so an inventory row says why a packaging job invokes a compiler.
export function programsIn(source, directory = '.', base = root, seen = new Set(), chain = []) {
  const found = [];
  const pkgPath = join(base, directory, 'package.json');
  const scripts = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {} : {};
  const clean = source.split('\n').map(line => line.replace(/^\s*#.*$/, '')).join('\n');
  for (const match of clean.matchAll(/\bnode\s+(?:\.\.\/)*scripts\/typecheck-budget\.mjs\s+([\w-]+)/g)) {
    const name = match[1];
    for (const program of budgets.groups[name] ?? [name]) {
      found.push({ program, chain: [...chain, name].join(' → '), managed: true });
      const emit = budgets.programs[program]?.emitProgram;
      if (emit && !budgets.groups[name] && !clean.includes('--noEmit')) found.push({ program: emit, chain: [...chain, name, emit].join(' → '), managed: true });
    }
  }
  for (const match of clean.matchAll(/(?:\btsc\b|typescript\/bin\/tsc['"]?)([^\n;&|]*)/g)) {
    const config = match[1].match(/(?:-p|--project)\s+['"]?([^\s'"]+)/)?.[1] ?? 'tsconfig.json';
    found.push({ program: join(directory, config), chain: [...chain, `tsc${match[1]}`].join(' → '), managed: false });
  }
  for (const match of clean.matchAll(/\b(?:pnpm|npm\s+run)\s+(?:(?:--filter|-F)\s+([^\s]+)\s+)?(?:run\s+)?([\w:-]+)/g)) {
    let [,filter,name] = match;
    let dir = directory;
    if (filter) {
      const workspace = { '@murage/docs': 'apps/docs', '@murage/control-plane': 'cloudflare/control-plane' }[filter];
      if (!workspace) throw new Error(`Uninventoried workspace ${filter}`);
      dir = workspace;
    }
    const key = `${dir}:${name}`;
    if (seen.has(key)) continue;
    const file = join(base, dir, 'package.json');
    const body = dir === directory ? scripts[name] : existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).scripts?.[name];
    if (body) found.push(...programsIn(body, dir, base, new Set([...seen, key]), [...chain, key]));
  }
  return found;
}

export function inventory(base = root) {
  const rows = [];
  for (const file of readdirSync(join(base, '.github/workflows')).filter(file => /\.ya?ml$/.test(file)).sort()) {
    const text = readFileSync(join(base, '.github/workflows', file), 'utf8');
    const counter = new LineCounter();
    const doc = parseDocument(text, { lineCounter: counter });
    if (doc.errors.length) throw new Error(`Invalid workflow ${file}`);
    const workflow = doc.toJS();
    const jobsNode = doc.get('jobs', true);
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      const stepsNode = jobsNode.get(id, true)?.get('steps', true);
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (!step.run) continue;
        const directory = step['working-directory'] ?? job.defaults?.run?.['working-directory'] ?? workflow.defaults?.run?.['working-directory'] ?? '.';
        if (directory.includes('${{')) throw new Error(`${file}:${id}: dynamic working directory needs inventory support`);
        const programs = programsIn(step.run, directory, base);
        if (!programs.length) continue;
        const env = { ...workflow.env, ...job.env, ...step.env };
        const line = counter.linePos(stepsNode.items[index].get('run', true).range[0]).line;
        // The quality matrix explicitly selects full Linux and production on
        // portable hosts. Validate both alternatives, rather than one regex hit.
        const variants = env.MURAGE_TYPECHECK_MODE?.includes('matrix.os') ? ['full', 'production'] : [env.MURAGE_TYPECHECK_MODE ?? 'full'];
        for (const mode of variants) {
          const selected = variants.length > 1 ? programsIn(`node scripts/typecheck-budget.mjs ${mode}`, '.', base) : programs;
          const options = String(env.NODE_OPTIONS ?? '');
          const caps = [...options.matchAll(/--max[-_]old[-_]space[-_]size=(\d+)/g)].map(match => Number(match[1]));
          const cap = variants.length > 1 ? caps[mode === 'full' ? 0 : 1] : caps[0];
          const portable = /macos|macOS/.test(JSON.stringify([job['runs-on'], job.strategy?.matrix?.os]));
          const ramMiB = variants.length > 1 && mode === 'full' ? 16 * 1024 : portable ? 7 * 1024 : 16 * 1024;
          for (const program of selected) rows.push({ file: `.github/workflows/${file}`, line, job: id, runner: job['runs-on'], ramMiB, mode, configuredCapMiB: cap ?? null, ...program });
        }
      }
    }
  }
  return rows;
}

export function validateAllocation(rows = inventory()) {
  for (const [name, entry] of Object.entries(budgets.programs)) {
    if (entry.recordedPeakMiB !== null) checkPeak(entry.recordedPeakMiB, entry.capMiB);
    if (entry.shards < 1 || !Number.isInteger(entry.shards)) throw new Error(`${name}: invalid shard count`);
  }
  for (const row of rows) {
    if (!row.managed) throw new Error(`${row.file}:${row.line}: compiler bypasses the resource guard (${row.program})`);
    const entry = budgets.programs[row.program];
    if (!entry) throw new Error(`${row.file}:${row.line}: unrecorded program ${row.program}`);
    if (row.configuredCapMiB !== null && row.configuredCapMiB < entry.capMiB) throw new Error(`${row.file}:${row.line}: ${row.program} requires ${entry.capMiB} MiB, job supplies ${row.configuredCapMiB}`);
    if (entry.capMiB > row.ramMiB * 0.6) throw new Error(`${row.file}:${row.line}: cap exceeds 60% of runner RAM`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rows = inventory();
  validateAllocation(rows);
  for (const row of rows) console.log(JSON.stringify(row));
}
