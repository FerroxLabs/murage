import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browserOwnerFields, browserInputFailure } from './browser-owner-request';
import { BrowserCloseFailure } from '../components/BrowserCloseFailure';
it('T20/T22 owner requests carry the viewed key and revision and show server refusal text', () => {
  expect(browserOwnerFields({ selectionRevision: 7, sessionKey: 'shared' })).toEqual({ expectedRevision: 7, expectedKey: 'shared' });
  expect(browserOwnerFields(null)).toEqual({});
  for (const code of ['client_outdated', 'revision_changed', 'browser_closing', 'browser_close_failed']) {
    expect(browserInputFailure({ code, message: 'server line' })).toBe('server line');
  }
});
it('T23 close failure presents one Restart action with the real bot name', () => {
  const html = renderToStaticMarkup(createElement(BrowserCloseFailure, { botName: 'Kai', pending: false, onRestart() {} }));
  expect(html).toContain("Kai&#x27;s browser didn&#x27;t close. Tap Restart to try again.");
  expect(html.match(/<button/g)).toHaveLength(1); expect(html).toContain('>Restart</button>');
});
