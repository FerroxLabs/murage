// Cloud recovery producer owner: Builder A win-sac-sign-sa; independent controller deployment, ARM authority and admission owner: MAIN.
import { pathToFileURL } from 'node:url';
const reject = code => { throw Error(`WINDOWS_WITNESS_${code}`); };
const nonce = value => /^[a-f0-9]{64}$/.test(value ?? '');
const kinds = new Map([['vm','virtualMachines'], ['os-disk','disks'], ['data-disk','disks'], ['nic','networkInterfaces']]);
function admission(resource, runNonce) {
  const segment = kinds.get(resource?.type);
  if (!nonce(runNonce) || resource?.runNonce !== runNonce || !segment
      || typeof resource.id !== 'string' || !new RegExp(`^/subscriptions/[a-fA-F0-9-]{36}/resourceGroups/[A-Za-z0-9_.()-]+/providers/Microsoft\\.(?:Compute|Network)/${segment}/[A-Za-z0-9_.()-]+$`, 'i').test(resource.id)
      || (resource.type === 'nic' ? !resource.id.toLowerCase().includes('/microsoft.network/') : !resource.id.toLowerCase().includes('/microsoft.compute/'))
      || typeof resource.uniqueId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(resource.uniqueId)
      || typeof resource.createdAt !== 'string' || !Number.isFinite(Date.parse(resource.createdAt))
      || typeof resource.owner !== 'string' || !/^[a-z0-9-]{1,64}$/.test(resource.owner)
      || typeof resource.purpose !== 'string' || !/^[a-z0-9-]{1,64}$/.test(resource.purpose)
      || typeof resource.expiresAt !== 'string' || !Number.isFinite(Date.parse(resource.expiresAt)) || Date.parse(resource.expiresAt) <= Date.parse(resource.createdAt)) reject('CLOUD_RESOURCE_BINDING');
}
function same(actual, resource) {
  if (!actual || typeof actual.id !== 'string' || actual.id.toLowerCase() !== resource.id.toLowerCase()
      || typeof actual.uniqueId !== 'string' || !actual.uniqueId || typeof actual.createdAt !== 'string' || !actual.createdAt) reject('CLOUD_QUERY');
  if (actual.uniqueId !== resource.uniqueId || actual.createdAt !== resource.createdAt) return false;
  if (actual.tags?.runNonce !== resource.runNonce || actual.tags?.owner !== resource.owner || actual.tags?.purpose !== resource.purpose || actual.tags?.expires_at !== resource.expiresAt) reject('CLOUD_RESOURCE_TAGS');
  return true;
}
/** The caller supplies an ARM adapter only in the portable harness; production selects no adapter until R-COL(11). */
export async function reapWindowsExtraction(runNonce, resources, arm = productionArmClient()) {
  if (!nonce(runNonce) || !Array.isArray(resources) || !arm || typeof arm.get !== 'function' || typeof arm.delete !== 'function') reject('CLOUD_RESOURCE_BINDING');
  const seen = new Set();
  // Admit the entire inventory before the first effect.
  for (const resource of resources) {
    admission(resource, runNonce); const id = resource.id.toLowerCase();
    if (seen.has(id)) reject('CLOUD_RESOURCE_REPLAY'); seen.add(id);
  }
  const report = { complete: true, absent: [], retained: [], failed: [] };
  const order = resources.filter(r => r.type === 'vm').concat(resources.filter(r => r.type !== 'vm'));
  for (const resource of order) {
    try {
      let actual = await arm.get(resource.id); // The adapter maps ONLY HTTP 404 to null; every other error propagates.
      if (actual !== null && !same(actual, resource)) { report.retained.push(resource.id); continue; }
      if (actual !== null) {
        // Conditional deletion closes GET/DELETE replacement races. The adapter must honor both incarnation and ETag.
        if (typeof actual.etag !== 'string' || !actual.etag) reject('CLOUD_ETAG');
        await arm.delete(resource.id, { ifMatch: actual.etag, uniqueId: resource.uniqueId, createdAt: resource.createdAt, runNonce });
        actual = await arm.get(resource.id);
      }
      if (actual === null) report.absent.push(resource.id);
      else if (!same(actual, resource)) report.retained.push(resource.id);
      else { report.complete = false; report.failed.push(resource.id); }
    } catch { report.complete = false; report.failed.push(resource.id); }
  }
  return report;
}
export function productionArmClient() { reject('CLOUD_REAPER_UNENROLLED_R_COL_11'); }
export async function superviseWindowsExtraction({ runNonce, resources, expiresAt }, lifetime, arm = productionArmClient()) {
  if (!Number.isFinite(Date.parse(expiresAt)) || typeof lifetime?.waitUntil !== 'function') reject('CLOUD_EXPIRY');
  if (!Array.isArray(resources)) reject('CLOUD_RESOURCE_BINDING');
  for (const resource of resources) {
    admission(resource, runNonce);
    if (Date.parse(expiresAt) > Date.parse(resource.expiresAt)) reject('CLOUD_EXPIRY');
  }
  await lifetime.waitUntil(expiresAt); // Independent controller process, not the extraction controller's finally block.
  return reapWindowsExtraction(runNonce, resources, arm);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { productionArmClient(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
