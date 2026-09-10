import { describe, expect, it } from "vitest";

import {
  browserProfileDeletionBlockReason,
  browserProfilePartitionId,
  browserProfilesForPatch,
  browserProfileReplacementPatch,
} from "./browser-profiles";

describe("browser profile deletion", () => {
  it("blocks a wipe while any assigned bot has a live turn", () => {
    const bots = [
      { name: "Researcher", browserProfile: "work", busy: true },
      { name: "Writer", browserProfile: "work", busy: false },
      { name: "Personal", browserProfile: "home", busy: true },
    ];
    expect(browserProfileDeletionBlockReason(bots, "work")).toBe(
      "Researcher is still running. Stop that bot before deleting this browser profile.",
    );
    expect(browserProfileDeletionBlockReason(bots, "unused")).toBeNull();
  });
});

describe("browser profile partition routing", () => {
  const profiles = [
    { id: "client", name: "Client", partitionId: "Client" },
    { id: "personal", name: "Personal" },
  ];

  it("resolves an immutable legacy partition without changing the public id", () => {
    expect(browserProfilePartitionId(profiles, "client")).toBe("Client");
    expect(browserProfilePartitionId(profiles, "personal")).toBe("personal");
    expect(browserProfilePartitionId(profiles, "missing")).toBe("missing");
  });

  it("strips internal partition metadata from config PATCH payloads", () => {
    expect(browserProfilesForPatch(profiles)).toEqual([
      { id: "client", name: "Client" },
      { id: "personal", name: "Personal" },
    ]);
  });

  it("captures detached expected and next lists without partition authority", () => {
    const original = [{ id: "work", name: "Work", partitionId: "Work" }];
    const patch = browserProfileReplacementPatch([...original, { id: "other", name: "Other" }], original);
    original[0]!.name = "Changed elsewhere";
    expect(patch).toEqual({ browserProfiles: [{ id: "work", name: "Work" }, { id: "other", name: "Other" }], expectedBrowserProfiles: [{ id: "work", name: "Work" }] });
  });
});
