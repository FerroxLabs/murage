// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #2462 (Apache-2.0).
//
// Source contract, like ChatView.test.ts: the renderer suite runs in node with
// no DOM. Switching to another thread of the same bot or room must re-arm
// follow-the-newest-message, so the key is the transcript, not the owner.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

it.each([["ChatView.tsx", "bot.id"], ["GroupView.tsx", "group.id"]])("%s re-arms bottom follow on the transcript key", (file, owner) => {
  const source = read(file);
  expect(source).toContain("useEffect(() => setBottomFollow(true), [transcriptKey, setBottomFollow]);");
  expect(source).not.toContain(`setBottomFollow(true), [${owner}, setBottomFollow]`);
  expect(source).toMatch(/\[transcriptKey, (messages|roomMessages)\.length, streaming/);
});
