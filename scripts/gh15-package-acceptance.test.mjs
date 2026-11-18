// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { launchVerificationServer } from './control-murage.ts';
const modulePath = './verify-gh15-linux-package.mjs';
const reporting = await import(modulePath).catch(() => ({}));
it('packaged reporting adapter proves independent manual and scheduled files and real delivery', async () => {
  expect(typeof reporting.verifyPackagedReporting, 'Packaged acceptance must exercise actual report output and delivery').toBe('function');
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/verify-gh15-linux-package.mjs')).href;
  const idle = pathToFileURL(join(process.cwd(), 'server/testing/idle-load-preload.mjs')).href;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    await import(${JSON.stringify(idle)});
    const {packagedReporterInstance,seedPackagedReporterHome} = await import(${JSON.stringify(moduleUrl)});
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');
    const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    seedPackagedReporterHome(process.env.HOME);
    cfg.instances.reporter=packagedReporterInstance(process.env.MURAGE_DATA_DIR);
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const evidence = process.env.SC_ISSUES_EVIDENCE ?? join(tmpdir(), 'murage-verification-evidence');
  mkdirSync(evidence, { recursive: true });
  try {
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json()).secret;
    const api = async (method, path, body) => {
      const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': secret }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const receipts = await reporting.verifyPackagedReporting(api, fixture.info.dataDir, evidence);
    expect(receipts).toHaveLength(2);
    expect(receipts[1].run.delivery.state).toBe('sent');
  } finally {
    // Retain the isolated server's diagnostic evidence even when reporting
    // fails before it can write a receipt. Closing still owns all fixture data.
    try { copyFileSync(fixture.info.logPath, join(evidence, 'gh15-server.log')); }
    finally { await fixture.close(); }
  }
}, 180000);
