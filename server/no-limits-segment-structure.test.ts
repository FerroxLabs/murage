// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import ts from 'typescript';
const root = resolve('server');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') && !/\.test\.ts$|\.d\.ts$/.test(e.name) ? [join(dir, e.name)] : []);
it('M-ONE and FA-IMPORT: one No limits tokenizer and archive grammar, unreachable from Full access readers', () => {
  const allowed = /^(?:no-limits-[^/]+\.ts|shell\/(?:roles|archive-roles)\.ts)$/;
  for (const file of files(root)) {
    const name = relative(root, file).replaceAll('\\', '/');
    const source = readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = relative(root, resolve(dirname(file), node.moduleSpecifier.text)).replaceAll('\\', '/');
      if (/^shell\/(?:segments|roles|archive-roles)\.ts$/.test(target)) expect(name, `${name} -> ${target}`).toMatch(allowed);
    }

  }
  const recovery = readFileSync(join(root, 'no-limits-protected.ts'), 'utf8').split('catch (error) {').at(-1)!;
  // MAIN r2 M-ONE is semantic: recovery consumes the same streaming context
  // reader as the owner branch. The frozen legacy scanner remains separate.
  expect(readFileSync(join(root,'no-limits-protected.ts'),'utf8')).toContain('forEachOwnerSegment(text,');
  const owner=readFileSync(join(root,'no-limits-shell.ts'),'utf8').split('/** Quote-aware executable segments.')[1]!;
  expect(owner).toContain('forEachSegment(text,');
  expect(owner).not.toMatch(/\bsegments\(/);
  expect(recovery).not.toMatch(/for\s*\([^)]*i\s*<\s*text\.length/);
});
