// SPDX-License-Identifier: AGPL-3.0-or-later
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileApprovalJournal } from '../approval-idempotency.ts';
import { toolCallActionId } from '../tool-call-binding.ts';
import { recoveryFixture } from './c2-recovery-fixture.ts';
const [dir, operation, accepted] = process.argv.slice(2);
const f = recoveryFixture(dir, operation);
f.api.always('GET', /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [] } });
if (accepted === 'before-claim') f.approvalJournal.claim = () => { process.exit(24); };
f.api.always('POST', /^\/opportunities\/(pipelines|upsert)$/, request => {
  const row = f.actions.get(toolCallActionId(f.claim, 'crash-rpc'))!;
  const association = new FileApprovalJournal(join(dir, 'approvals', 'recovery')).get(row.actionId);
  if (association?.state !== 'applied' || !(association.result as any).plan.readTargets.length
    || JSON.stringify(association).includes('Reviewed')) process.exit(26);
  writeFileSync(join(dir, 'provider.json'), JSON.stringify({ posts: 1, accepted: accepted === 'true', body: request.body }));
  process.exit(24);
});
await f.call();
process.exit(25);
