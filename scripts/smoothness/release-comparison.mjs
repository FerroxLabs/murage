// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
/** Refuse a release claim until both full ID comparisons cover the pinned trees. */
export function requireReleaseComparisons(vitest, node, {baseSha,headSha}) {
  for (const [name, comparison] of [['vitest',vitest],['node',node]]) {
    assert.equal(comparison.base_sha,baseSha,`${name}: wrong BASE SHA`);
    assert.equal(comparison.head_sha,headSha,`${name}: wrong HEAD SHA`);
    assert.equal(comparison.complete,true,`${name}: comparison incomplete`);
    assert.equal(comparison.no_new_red,true,`${name}: new or unqualified failures`);
    for (const key of ['new_red','new_skips','missing_ids',...(name==='vitest'?['new_suite_error_files','removed_files']:[])]) {
      assert.ok(Array.isArray(comparison[key]),`${name}: missing ${key}`);
      assert.deepEqual(comparison[key],[],`${name}: ${key}`);
    }
    for(const side of ['base','head']) {
      if(name==='node') assert.deepEqual(comparison[side].errors,[],`node: ${side} structural errors`);
      assert.ok(comparison[side].shards.length>0&&comparison[side].shards.length<=8,`${name}: shard count`);
      assert.ok(comparison[side].shards.every(shard=>shard.complete===true),`${name}: ${side} unfinished`);
    }
  }
  return {baseSha,headSha,newFailures:0};
}
