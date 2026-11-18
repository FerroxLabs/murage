// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture-stage probe owner: warm-capture (arev-conf-warmcap-par Medium jobs.ts:36). Consumer: worker-controller claim retry.
import { beforeEach, expect, it } from 'vitest';
import { database } from '../database.ts';
import { hasClaimableCaptureJob } from './jobs.ts';
import { captureAndPublish, freshDataDir } from './testing/recall-fixture.ts';

let jobId='';
beforeEach(()=>{freshDataDir('capture');({jobId}=captureAndPublish('The fixture gate is green.','fixture-source'));});
const job=(id:string,stage:string,status:string,retryAt:number)=>database().prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,policy_revision,deletion_epoch) SELECT ?,source_id,source_revision,?,'fixture-v',?,?,policy_revision,deletion_epoch FROM memory_jobs WHERE id=?").run(id,stage,status,retryAt,jobId);
const backlog=(n:number)=>{for(let i=0;i<n;i++)job(`fixture-noise-${i}`,`fixture-stage-${i}`,'pending',0);};

it('a due capture job behind a short non-capture backlog is seen',()=>{
 job('fixture-capture','capture','pending',1);backlog(3);
 expect(hasClaimableCaptureJob(10)).toBe(true);
 expect(hasClaimableCaptureJob(0), 'not yet due').toBe(false);
});

it('the probe reads a bounded window of due jobs: a non-capture backlog is not scanned to its end',()=>{
 job('fixture-capture','capture','pending',1);backlog(200);
 expect(hasClaimableCaptureJob(10), 'past the bounded window the short capture retry is not taken (the minute retry applies)').toBe(false);
 database().prepare("DELETE FROM memory_jobs WHERE id LIKE 'fixture-noise-%' AND CAST(substr(id,15) AS INTEGER)>=8").run();
 expect(hasClaimableCaptureJob(10)).toBe(true);
});
