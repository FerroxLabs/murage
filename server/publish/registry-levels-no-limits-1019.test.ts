// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { fixture } from '../decision/fixture.ts';
import { Store } from '../store.ts';
import { saveConfig } from '../config.ts';
import { installPermissionInheritance } from '../permission-inheritance.ts';

let restore = () => {};
afterEach(() => { restore(); restore = () => {}; });
const sites = () => Array.from({ length: 201 }, (_, index) => ({
  siteId: `site-${index}`, name: `fixture-${index}`, url: `https://fixture-${index}.netlify.app`,
  lastPublishedAt: 1, lastFileCount: 1, origin: 'created' as const,
}));

it.each(['ask', 'full', 'unlimited', 'inherited'] as const)('site registry preserves the 1.0.18 ceiling below No limits: %s', level => {
  const f = fixture('ask');
  restore = installPermissionInheritance(() => level === 'inherited');
  const bot = f.store.createBot({ name: 'Registry fixture' }, { seedMessages: false });
  const unlimited = level === 'unlimited';
  f.store.patchBot(bot.id, {
    ...(level === 'inherited' ? { permissionExplicit: false } : {
      permissionExplicit: true, autoApprove: level !== 'ask', fullAccess: level !== 'ask', noLimits: unlimited,
    }),
    publishedSites: sites(),
  });
  const reopened = new Store();
  expect(reopened.bot(bot.id)?.publishedSites).toHaveLength(unlimited || level === 'inherited' ? 201 : 200);
});

it('an inherited No limits registry survives startup before the live inheritance reader is installed', () => {
  const f = fixture('ask');
  const bot = f.store.createBot({ name: 'Inherited registry fixture' }, { seedMessages: false });
  f.store.patchBot(bot.id, { permissionExplicit: false, publishedSites: sites() });
  saveConfig({ newBots: { permissionLevel: 'no-limits' } });
  restore = installPermissionInheritance(() => false);
  expect(new Store().bot(bot.id)?.publishedSites).toHaveLength(201);
});
