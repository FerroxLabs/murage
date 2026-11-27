#!/usr/bin/env node
// Producer: MAIN packaging/capture runners and integration expected identity.
// Consumer: TRUST-V2-d checker; release publication owner: MAIN.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mergeCheck, readRealTurns } from './fuigo-bump.mjs';

export function trustReleaseGate({ expectedFile, receiptFile, capturesDir, expectedSha }) {
  if (!expectedFile || !receiptFile || !capturesDir || !/^[a-f0-9]{40}$/.test(expectedSha ?? ''))
    throw new Error('Fuigo trust release evidence is required: independent expected identity, receipt, all captures and final integration SHA');
  const expected = JSON.parse(readFileSync(expectedFile, 'utf8'));
  if (expected?.murageSha !== expectedSha) throw new Error('clause:release-identity: expected release manifest differs from the integration SHA');
  mergeCheck(JSON.parse(readFileSync(receiptFile, 'utf8')), readRealTurns(capturesDir), expected);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  trustReleaseGate({ expectedFile: process.env.MURAGE_TRUST_EXPECTED_RELEASE, receiptFile: process.env.MURAGE_TRUST_RECEIPT,
    capturesDir: process.env.MURAGE_TRUST_CAPTURES, expectedSha: process.env.SHA });
}
