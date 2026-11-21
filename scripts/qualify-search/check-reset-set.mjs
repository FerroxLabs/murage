// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync} from 'node:fs';
const data=JSON.parse(readFileSync(process.argv[2],'utf8'));
const tests=data.testResults.flatMap(x=>x.assertionResults);
for(const pattern of [/T-RESET-HANDSHAKE/,/C15': SIGKILL reset-before-delete/,/C15': SIGKILL reset-after-wal-delete/,/T-REC-RESET/,/T-REC-PERSISTENT/,/T-REC-WINDOW/,/T-REC-DEFER/,/T-REC-ONCE/,/T-SCRUB-BACKOFF/,/T-SCRUB-NOSTARVE/,/T-SCRUB-RECOVER/,/T-SCRUB-CAP/]){
  const found=tests.filter(x=>pattern.test(x.fullName));
  if(!found.length||found.some(x=>x.status!=='passed'))throw Error('reset qualification set missing or failed: '+pattern);
}
