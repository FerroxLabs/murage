// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { automationsOperations } from './automations.ts';
import { formsOperations } from './forms.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../src/locales/${name}.json`, import.meta.url), 'utf8')) as Record<string, string>;
describe('F5 locale copy coverage', () => {
  for (const spec of [...automationsOperations, ...formsOperations]) {
    it(`${spec.id} has source copy and all shipped translations`, () => {
      const key = `highlevel.operation.${spec.id}`;
      expect(read('en')[key]).toBe(spec.title);
      for (const locale of ['de', 'es', 'fr', 'hi', 'ja', 'pt-br', 'zh']) {
        expect(read(locale)[key]).toBeTruthy();
        expect(read(locale)[key]).not.toBe(spec.title);
        expect(read(locale)[key]).not.toMatch(/\u2014/);
      }
    });
  }
});

it('F5 diagnostics and explicit refusals have copy in every shipped locale', () => {
  for (const key of ['urls', 'campaigns', 'location', 'contact', 'automation', 'unconfirmed', 'dates', 'tooLarge', 'unsupported']) {
    for (const locale of ['en', 'de', 'es', 'fr', 'hi', 'ja', 'pt-br', 'zh']) {
      expect(read(locale)[`highlevel.f5.${key}`]).toBeTruthy();
      expect(read(locale)[`highlevel.f5.${key}`]).not.toMatch(/\u2014/);
    }
  }
});
