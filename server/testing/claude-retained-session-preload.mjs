// SPDX-License-Identifier: AGPL-3.0-or-later
// Receipt producer owner: sc-safety; retained-session fixture consumer: c4-misc-a2.
// MAIN RULING INT-CONFLICT-DEFAULT: use the reviewed exact scripted-CLI receipt
// for a fixture that requires S2 retention. Real CLI admission stays unchanged.
import { isMainThread } from 'node:worker_threads';
import { registerHooks } from 'node:module';
if (isMainThread) registerHooks({load(url, context, next) {
  const loaded=next(url,context);
  if(!url.endsWith('/server/drivers/claude.ts'))return loaded;
  const source=typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source).toString('utf8');
  const anchor='import { claudeS2QualifiedCli, claudeS2QualifiedCliNow } from "./claude-s2-qualification.ts";';
  if(source.split(anchor).length!==2)throw Error('Retained-session fixture qualification anchor moved');
  return {...loaded,source:source.replace(anchor,`
import * as fixtureQualification from "./claude-s2-qualification.ts";
import { withClaudeWireReceipt } from "../testing/claude-s2-fixture-receipt.ts";
const {claudeS2QualifiedCli,claudeS2QualifiedCliNow}=withClaudeWireReceipt(fixtureQualification);
`)};
}});
