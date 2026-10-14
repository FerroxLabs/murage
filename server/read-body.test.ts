// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { readBody } from "./read-body.ts";

it("keeps a multi-byte character that is split across two chunks", async () => {
  const text = "é".repeat(40_000) + "日本語";
  const bytes = Buffer.from(JSON.stringify({ text }));
  const cut = bytes.indexOf(Buffer.from("é")) + 1; // inside the first two-byte character
  const req = new PassThrough();
  const done = readBody(req as unknown as IncomingMessage, 10_000_000);
  req.write(bytes.subarray(0, cut));
  req.write(bytes.subarray(cut, 70_001));
  req.end(bytes.subarray(70_001));
  expect((await done).text).toBe(text);
});
