import { expect, it } from 'vitest';
import { productionArmClient, reapWindowsExtraction, superviseWindowsExtraction } from './windows-extraction-reaper.mjs';
const run = 'a'.repeat(64);
function fixture() {
  const resources = [['vm','Compute/virtualMachines'],['os-disk','Compute/disks'],['data-disk','Compute/disks'],['nic','Network/networkInterfaces']].map(([type, path], n) => ({ type, runNonce: run,
    id: `/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/neutral/providers/Microsoft.${path}/resource-${n}`,
    uniqueId: `generation-${n}`, createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z', owner: 'neutral', purpose: 'extraction' }));
  const live = new Map(resources.map(r => [r.id, { ...r, etag: 'revision', tags: { runNonce: run, owner: r.owner, purpose: r.purpose, expires_at: r.expiresAt } }]));
  const deleted = [];
  const arm = { async get(id) { return live.get(id) ?? null; }, async delete(id, binding) {
    expect(binding).toEqual({ ifMatch: live.get(id).etag, uniqueId: live.get(id).uniqueId, createdAt: live.get(id).createdAt, runNonce: run });
    deleted.push(id); live.delete(id);
  } };
  return { resources, live, deleted, arm };
}
it('reaps VM, OS disk, data disk and NIC independently and is idempotent', async () => {
  const f = fixture(); const report = await reapWindowsExtraction(run, f.resources, f.arm);
  expect(report).toEqual({ complete: true, absent: f.resources.map(r => r.id), retained: [], failed: [] });
  expect(f.deleted).toEqual(f.resources.map(r => r.id));
  expect((await reapWindowsExtraction(run, f.resources, f.arm)).complete).toBe(true); expect(f.deleted).toHaveLength(4);
});
it.each(['uniqueId','createdAt'])('M-A14 retains foreign %s with no delete', async field => {
  const f = fixture(); f.live.get(f.resources[0].id)[field] += '-foreign';
  const report = await reapWindowsExtraction(run, f.resources, f.arm);
  expect(report.retained).toEqual([f.resources[0].id]); expect(f.deleted).not.toContain(f.resources[0].id); expect(report.complete).toBe(true);
});
it.each(['runNonce','owner','purpose','expires_at'])('refuses changed resource tag %s and continues other cleanup', async field => {
  const f = fixture(); f.live.get(f.resources[0].id).tags[field] = 'foreign';
  const report = await reapWindowsExtraction(run, f.resources, f.arm);
  expect(report.complete).toBe(false); expect(report.failed).toEqual([f.resources[0].id]); expect(f.deleted).toHaveLength(3);
});
it.each(['runNonce','type','id','uniqueId','createdAt','owner','expiresAt'])('rejects inventory %s before all effects', async field => {
  const f = fixture(); f.resources[3][field] = '';
  await expect(reapWindowsExtraction(run, f.resources, f.arm)).rejects.toThrow('BINDING'); expect(f.deleted).toEqual([]);
});
it('GET errors and surviving resources are incomplete without stopping the other reapers', async () => {
  const f = fixture(); const get = f.arm.get; f.arm.get = async id => { if (id === f.resources[0].id) throw Error('neutral'); return get(id); };
  f.arm.delete = async () => {};
  const report = await reapWindowsExtraction(run, f.resources, f.arm);
  expect(report.complete).toBe(false); expect(report.failed).toHaveLength(4);
});
it('replacement between GET and DELETE fails the conditional delete and retains the foreign incarnation', async () => {
  const f = fixture(); f.arm.delete = async () => { throw Error('precondition failed'); };
  expect((await reapWindowsExtraction(run, f.resources, f.arm)).complete).toBe(false); expect(f.deleted).toEqual([]);
});
it('independent expiry waits before reaping; production ARM remains unenrolled', async () => {
  const f = fixture(); let waited = false;
  const get = f.arm.get; f.arm.get = id => { expect(waited).toBe(true); return get(id); };
  const report = await superviseWindowsExtraction({ runNonce: run, resources: f.resources, expiresAt: f.resources[0].expiresAt }, { async waitUntil() { waited = true; } }, f.arm);
  expect(report.complete).toBe(true); expect(() => productionArmClient()).toThrow('UNENROLLED_R_COL_11');
});
it.each([undefined, {}, {id:'foreign'}, {uniqueId:'foreign'}])('malformed ARM observation %j cannot prove absence', async observation => {
  const f = fixture(); f.arm.get = async () => observation;
  const report = await reapWindowsExtraction(run, f.resources, f.arm);
  expect(report.complete).toBe(false); expect(report.failed).toHaveLength(4); expect(f.deleted).toEqual([]);
});
it('independent expiry cannot exceed the admitted resource expiry', async () => {
  const f = fixture(); let waited = false;
  await expect(superviseWindowsExtraction({runNonce:run,resources:f.resources,expiresAt:'2026-01-03T00:00:00Z'}, {async waitUntil(){waited=true;}}, f.arm)).rejects.toThrow('CLOUD_EXPIRY');
  expect(waited).toBe(false); expect(f.deleted).toEqual([]);
});
