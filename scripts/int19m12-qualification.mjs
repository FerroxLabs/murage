// SPDX-License-Identifier: AGPL-3.0-or-later
export const COMPARISON_BASE = 'f6b9b86de72d64bd10f1d0363b7d44f58ae3af32';
export const INTEGRATION_START = 'ca5978bf07aabdae66cc132969d26073f31f372b';
export function assertComparisonBase(sha) {
  if (sha !== COMPARISON_BASE) throw Error('comparison-base-mismatch');
}
export function compareIds(base, head) {
  const newReds=[];
  for(const [id,status] of Object.entries(head)) if(status==='failed' && base[id]!=='failed') newReds.push(id);
  return newReds.sort();
}
/** A lane's older RED or an import error cannot establish integration-start behavior. */
export function assertIntegrationRedCoverage(behaviors, receipts) {
  for(const behavior of behaviors) {
    const receipt=receipts.find(row=>row.behavior===behavior);
    if(!receipt || receipt.source!==INTEGRATION_START || receipt.red!=='assertion-failed' || receipt.green!=='passed' || receipt.mutant!=='assertion-failed') throw Error('integration-start-red-unproved: '+behavior);
  }
}
