// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-f. Consumer owner: MAIN; native admission owner: scperf-p1.
import type { InternalCapabilities, InternalCapability } from '../internal-capabilities.ts';
import { database, isDatabaseBusy, transaction, writersHeldForIndexBuild } from '../database.ts';
import { ioBudget, isBgDeferred, withPreparedStatementReuse } from '../io-budget.ts';
import { ioGrantSnapshot, ioMeterSqlDeadline, ioMeterWallTime } from '../io-meter.ts';
import { threadMemoryCaptures } from './capture.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { captureWork } from './chunks.ts';
import { refreshMemoryCheckpoint, writetimeSourceState } from './consolidate.ts';

const attempted = new WeakSet<InternalCapability>();
const pendingCheckpoint = new Error('MEMORY_CHECKPOINT_PENDING');

/** One synchronous opportunity on the matched live turn, without allocating a reader view. */
export function materializeTerminalMemory(registry: InternalCapabilities, claim: InternalCapability, messageId: string): 'complete' | 'pending' {
  if (claim.kind !== 'memory' || !registry.isActive(claim)) throw new Error('MEMORY_UNAUTHORIZED');
  if (attempted.has(claim)) return 'pending';
  attempted.add(claim);
  if (!ioMeterSqlDeadline() || database().isTransaction || ioGrantSnapshot().live) return 'pending';
  const deadline = Math.min(ioMeterWallTime() + 25, claim.expiresAt, ioBudget.currentSliceDeadline());
  const current = () => {
    if (!registry.isActive(claim)) throw new Error('MEMORY_UNAUTHORIZED');
    return ioMeterWallTime() < deadline && threadMemoryCaptures(database(), claim.threadId);
  };
  if (writersHeldForIndexBuild() || ioBudget.deferredForMs('memory-worker', { requested: true }) > 0 || !current()) return 'pending';
  const sourceId = `message:${claim.threadId}:${messageId}`;
  const job = database().prepare("SELECT j.id,s.revision,octet_length(v.payload) AS payload_bytes FROM memory_sources s JOIN memory_jobs j ON j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' AND j.stage_version='1' JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=? AND s.thread_id=? AND s.kind='text' AND s.state='active'").get(sourceId, claim.threadId);
  // SQLite's JSON function is one native instruction: bound its input before parsing it.
  if (!job || Number(job.payload_bytes) > 2 * 65536) return 'pending';
  const sourceCurrent = () => {
    const source = database().prepare('SELECT s.*,octet_length(v.payload) AS payload_bytes FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?').get(sourceId);
    return source !== undefined && source.revision === job.revision && Number(source.payload_bytes) <= 2 * 65536 && writetimeSourceState(source) === 'shown';
  };
  try {
    return ioBudget.withSyncSource('memory-terminal', () => withPreparedStatementReuse(() => transaction(() => {
      for (let slice = 0; slice < 2 && current(); slice++) {
        if (!sourceCurrent()) return 'pending';
        const work = claimMemoryJob(claim.generation, Date.now(), undefined, { jobId: String(job.id), busyMs: 0 });
        if (!work) {
          const state = database().prepare('SELECT status,source_id,source_revision FROM memory_jobs WHERE id=?').get(job.id);
          if (state?.status !== 'complete' || state.source_id !== sourceId || state.source_revision !== job.revision || !current() || !sourceCurrent()) return 'pending';
          return refreshMemoryCheckpoint(String(job.id), { maxPayloadBytes: 2 * 65536 }).status === 'deferred' ? 'pending' : 'complete';
        }
        if (work.sourceId !== sourceId || work.revision !== job.revision) throw new Error('STALE_MEMORY_SOURCE');
        if (!current()) return 'pending';
        const result = captureWork(work);
        if (!current() || !sourceCurrent()) return 'pending';
        publishMemoryWork(work, claim.generation, result, Date.now(), { busyMs: 0 });
        if (result.status === 'complete') {
          if (!current()) throw pendingCheckpoint;
          const checkpoint = refreshMemoryCheckpoint(work.id, { maxPayloadBytes: 2 * 65536 });
          if (checkpoint.status === 'deferred') throw pendingCheckpoint;
          return 'complete';
        }
      }
      return 'pending';
    }, { op: 'terminal-capture', busyMs: 0 })), deadline);
  } catch (error) {
    if (error === pendingCheckpoint || isDatabaseBusy(error) || isBgDeferred(error) || (error as { errcode?: number } | null | undefined)?.errcode === 9) return 'pending';
    throw error;
  }
}
