// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";

it("restore requires the captured fourth-argument owner fence before dispatch or saved-result lookup", async () => {
  const fake = new FakeFlux().always("POST", /\/restore$/, { status: 200, body: { id: "inbox", state: "active" } });
  let owner = "owner-first";
  const read = vi.fn(() => null);
  const client = new FluxEmailClient({
    fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
    credentials: { account: () => null, owner: () => ({ token: "fixture", keyId: owner }), ownerRef: () => owner, bot: () => null },
    restoreOutcomes: { read, write: () => {} },
  });
  for (const fence of [undefined, "", "owner-other"]) {
    await expect(client.restoreInbox("inbox", "bot", "restore", fence)).resolves.toMatchObject({ kind: "uncertain", reason: "owner_changed" });
  }
  // The old three-argument signature cannot promote a live account into authority.
  await expect(client.restoreInbox("inbox", "bot", owner)).resolves.toMatchObject({ kind: "uncertain", reason: "owner_changed" });
  expect(fake.requests).toHaveLength(0);
  expect(read).not.toHaveBeenCalled();
  await expect(client.restoreInbox("inbox", "bot", "restore", owner)).resolves.toMatchObject({ kind: "ok", usedOwnerRef: owner });
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]!.headers["idempotency-key"]).toBe("restore");
  // An in-memory committed result also requires the caller's captured fence.
  await expect(client.restoreInbox("inbox", "bot", "restore")).resolves.toMatchObject({ kind: "uncertain", reason: "owner_changed" });
  const captured = owner;
  owner = "owner-next";
  await expect(client.restoreInbox("inbox", "bot", "restore", captured)).resolves.toMatchObject({ kind: "uncertain", reason: "owner_changed" });
  expect(fake.requests).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(1);
});
