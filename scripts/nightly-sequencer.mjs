// SPDX-License-Identifier: AGPL-3.0-or-later
import { relative } from "node:path";
import { BaseSequencer } from "vitest/node";

// Rounded Vitest durations from the Linux rebaseline and nightly-tagged timing run.
const seconds = {
  "server/branch-store.test.ts": 17,
  "server/cowork-playbook-delivery.test.ts": 26,
  "server/handoff-dispatch.structure.test.ts": 43,
  "server/inbox.base-equivalence.test.ts": 29,
  "server/index-4.test.ts": 67,
  "server/memory/first-start-work.test.ts": 26,
  "server/memory/msearch-r6.test.ts": 236,
  "server/memory/msearch-review.test.ts": 59,
  "server/memory/msearch2-r2c.test.ts": 118,
  "server/memory/owner-tail.test.ts": 92,
  "server/memory/revoke-budget.test.ts": 122,
  "server/memory/revoke-marker.test.ts": 40,
  "server/memory/revoke-window.test.ts": 22,
  "server/memory/testing/b34-extractor-adapter.test.ts": 255,
  "server/memory/upgrade-fix-r8.test.ts": 3,
  "server/memory/writetime-differential.test.ts": 150,
  "server/p3-store-scale.test.ts": 21,
  "server/pm-sends-102-r17.test.ts": 50,
  "server/pm-sends-102-r18.test.ts": 130,
  "server/pm-sends-102-r20.test.ts": 69,
  "server/pm-sends-102-r25.test.ts": 141,
  "server/project-turn-engine-api.test.ts": 17,
  "server/respond-authority.test.ts": 56,
  "server/transcript-scale.test.ts": 38,
};

// Nightly #107–109 on macOS took a median 156 minutes across roughly 5,700 files, including tagged tests.
const defaultSeconds = 1.5;

export default class NightlySequencer extends BaseSequencer {
  async shard(files) {
    const { root, shard: { index, count } } = this.ctx.config;
    const shards = Array.from({ length: count }, () => ({ seconds: 0, files: [] }));
    const weighted = files.map(file => {
      const path = relative(root, file.moduleId).replaceAll("\\", "/");
      return { file, path, time: seconds[path] ?? defaultSeconds };
    });
    weighted.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));
    for (const { file, time } of weighted) {
      const lightest = shards.reduce((a, b) => a.seconds <= b.seconds ? a : b);
      lightest.files.push(file);
      lightest.seconds += time;
    }
    return shards[index - 1].files;
  }
}
