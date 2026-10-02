// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import * as inboxChanged from "./inbox-changed";

it("a change announced while a read is out reads once more after it, never in parallel", async () => {
  const serial = (inboxChanged as Record<string, unknown>).serialRefresh as ((read: () => Promise<void>) => () => Promise<void>) | undefined;
  expect(typeof serial).toBe("function");
  const releases: Array<() => void> = [];
  let running = 0, peak = 0, reads = 0;
  const refresh = serial!(async () => {
    reads++; running++; peak = Math.max(peak, running);
    await new Promise<void>(resolve => releases.push(resolve));
    running--;
  });
  const first = refresh();
  // Two notices land while the first read is out. That read may have been
  // answered before the write, so ONE more read must follow it.
  void refresh(); void refresh();
  expect(reads).toBe(1);
  releases.shift()!(); await first;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(reads).toBe(2);
  releases.shift()!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(reads).toBe(2);
  expect(peak).toBe(1);
});
