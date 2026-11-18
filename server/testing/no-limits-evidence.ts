// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Live fixture captures belong outside the checkout, independently of frozen inputs. */
export function noLimitsEvidence(name: string): URL {
  const root=process.env.MURAGE_TEST_EVIDENCE_DIR??mkdtempSync(join(tmpdir(),'murage-nl-evidence-'));
  const path=join(root,name);
  mkdirSync(path,{recursive:true});
  return pathToFileURL(path+'/');
}
