// SPDX-License-Identifier: AGPL-3.0-or-later
// T09: the extension's own strings (tab group titles, page overlay, side panel)
// and the desktop app's `browserExt.` strings. One owner, every language, the
// same placeholders everywhere.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const EXT = 'extensions/murage-browser';
const EXT_LANGS = ['en', 'es', 'fr', 'de', 'pt_BR', 'ja', 'zh_CN', 'hi'];
const APP_LANGS = ['de', 'es', 'fr', 'hi', 'ja', 'pt-br', 'zh'];
const tokens = (text) => [...String(text).matchAll(/\$([A-Z0-9_]+)\$/g)].map((match) => match[1]).sort();
const braces = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const messages = (lang) => read(`${EXT}/_locales/${lang}/messages.json`);

describe('manifest localisation', () => {
  const manifest = read(`${EXT}/manifest.json`);
  it('names the default locale and takes name and description from the catalogue', () => {
    expect(manifest.default_locale).toBe('en');
    expect(manifest.name).toBe('__MSG_extName__');
    expect(manifest.description).toBe('__MSG_extDescription__');
  });
  it('every __MSG_ reference in the manifest has an English entry', () => {
    const refs = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((match) => match[1]);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    const en = messages('en');
    for (const ref of refs) expect(en[ref]?.message, ref).toBeTruthy();
  });
  it('is called Murage for Chrome, within the store limits', () => {
    const en = messages('en');
    expect(en.extName.message).toBe('Murage for Chrome');
    expect(en.extName.message.length).toBeLessThanOrEqual(45);
    expect(en.extDescription.message.length).toBeLessThanOrEqual(132);
    for (const lang of EXT_LANGS) {
      expect(messages(lang).extName.message, lang).toBe('Murage for Chrome');
      expect(messages(lang).extDescription.message.length, lang).toBeLessThanOrEqual(132);
    }
  });
  it('declares nothing else new in the manifest', () => {
    expect(Object.keys(manifest).sort()).toEqual(['action', 'background', 'commands', 'content_security_policy', 'default_locale', 'description', 'icons', 'incognito', 'manifest_version', 'minimum_chrome_version', 'name', 'permissions', 'side_panel', 'version']);
  });
});

describe('extension message catalogues', () => {
  it('ships exactly the eight languages', () => {
    expect(readdirSync(new URL(`../${EXT}/_locales`, import.meta.url)).sort()).toEqual([...EXT_LANGS].sort());
  });
  it('holds the tab group keys the tab group builder reads', () => {
    const en = messages('en');
    for (const key of ['groupTitle', 'groupTitleBot', 'groupSuffixPaused', 'groupSuffixStopped', 'groupSuffixYourTurn', 'groupSuffixFull', 'groupSuffixWorking', 'groupSuffixDone'])
      expect(en[key]?.message, key).toBeTruthy();
    expect(en.groupTitle.message).toBe('Murage');
    expect(en.groupTitleBot.message).toBe('Murage · $BOT$');
  });
  for (const lang of EXT_LANGS.filter((lang) => lang !== 'en')) {
    it(`${lang} has every English key, the same placeholders and no empty text`, () => {
      const en = messages('en');
      const pack = messages(lang);
      expect(Object.keys(pack).sort()).toEqual(Object.keys(en).sort());
      for (const [key, entry] of Object.entries(pack)) {
        expect(entry.message?.trim(), `${lang}.${key}`).toBeTruthy();
        expect(tokens(entry.message), `${lang}.${key}`).toEqual(tokens(en[key].message));
        expect(Object.keys(entry.placeholders ?? {}).sort(), `${lang}.${key} placeholders block`).toEqual(Object.keys(en[key].placeholders ?? {}).sort());
        expect(entry.message, `${lang}.${key}`).not.toMatch(/—/);
      }
    });
  }
  it('every token in English has a placeholder definition', () => {
    for (const [key, entry] of Object.entries(messages('en'))) {
      for (const token of tokens(entry.message)) expect(entry.placeholders?.[token.toLowerCase()]?.content, `${key} ${token}`).toMatch(/^\$[1-9]$/);
    }
  });
  it('never calls the product Murage in Chrome', () => {
    for (const lang of EXT_LANGS) expect(JSON.stringify(messages(lang))).not.toMatch(/Murage in Chrome/i);
  });
});

describe('desktop browserExt strings', () => {
  const en = read('src/locales/en.json');
  const keys = Object.keys(en).filter((key) => key.startsWith('browserExt.'));
  it('holds every card, your turn, refusal, mode, dialog, panel and checker string', () => {
    expect(keys.length).toBeGreaterThanOrEqual(100);
    for (const key of ['browserExt.site.title', 'browserExt.l2.body', 'browserExt.l3.send.title', 'browserExt.yourTurn.credentials', 'browserExt.refuse.hiddenControl', 'browserExt.mode.floorNote', 'browserExt.full.title', 'browserExt.full.confirmLabel', 'browserExt.panel.useMyBrowser', 'browserExt.preview.note', 'browserExt.checker.blocked', 'browserExt.checker.unavailable', 'browserExt.checker.settingsLine', 'browserExt.checker.askEachStepUntil'])
      expect(en[key], key).toBeTruthy();
  });
  const hashes = read('src/locales/source-hashes.json').locales;
  for (const lang of APP_LANGS) {
    it(`${lang} translates every key, keeps the placeholders and records the source hash`, () => {
      const pack = read(`src/locales/${lang}.json`);
      for (const key of keys) {
        expect(pack[key]?.trim(), `${lang} ${key}`).toBeTruthy();
        expect(braces(pack[key]), `${lang} ${key}`).toEqual(braces(en[key]));
        expect(pack[key], `${lang} ${key}`).not.toMatch(/—/);
        expect(hashes[lang][key], `${lang} ${key} hash`).toBe(createHash('sha256').update(en[key]).digest('hex'));
      }
    });
  }
  it('German and French address the owner informally', () => {
    const de = read('src/locales/de.json');
    const fr = read('src/locales/fr.json');
    for (const key of keys) {
      expect(de[key], key).not.toMatch(/\b(Ihr\w*|Ihnen)\b/);
      expect(de[key], key).not.toMatch(/(?<!^)(?<![.!?:] )\bSie\b/);
      expect(fr[key], key).not.toMatch(/\b(vous|votre|vos)\b/i);
    }
  });
  it('the extension files exist', () => {
    expect(existsSync(new URL(`../${EXT}/_locales/en/messages.json`, import.meta.url))).toBe(true);
  });
});
