// MAIN ruling, 2026-11-11 11:15Z: browser vendor draft construction is
// permitted release assembly. Publication remains owned by release.yml.
import { createHash } from 'node:crypto';

export const BROWSER_ASSEMBLY_WORKFLOW = '.github/workflows/build-browser-vendor.yml';
export const BROWSER_ASSEMBLY_JOB = 'draft-release';
export const DRAFT_ASSEMBLY_REASON = 'MAIN 2026-11-11 11:15Z ruling: permitted release assembly; creates drafts only and refuses upload to a non-draft tag';

// Pin the complete reviewed job (actions, credentials, conditions, shell and
// commands), rather than treating its path or a --draft substring as authority.
// Any change requires a new review, including a removed/reordered isDraft check.
const reviewedJob = '53c342080cba5dedc72edac0c12133c957e867f4acc3b315ad59a1dd74baae89';
export function classifyDraftAssembly(file, id, job) {
  if (file !== BROWSER_ASSEMBLY_WORKFLOW || id !== BROWSER_ASSEMBLY_JOB || !job) return undefined;
  if (createHash('sha256').update(JSON.stringify(job)).digest('hex') !== reviewedJob) return undefined;
  return { kind: 'assembly', owner: 'browserVendorDraftAssembly', reason: DRAFT_ASSEMBLY_REASON };
}
