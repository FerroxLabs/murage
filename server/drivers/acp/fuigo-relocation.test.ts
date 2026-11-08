import { describe, expect, it } from "vitest";
import * as policy from "./fuigo-policy.ts";

const current = "/fixture/new";
const previous = "/fixture/old";
const record = { root: previous, sha256: policy.FUIGO_POLICY_SHA256 };
const relocation = { previous, copied: false };
const raw = () => ({ code: -32602, data: {
  policy_error: "session_policy_conflict",
  path: policy.fuigoPolicyPath(current),
  message: `this session is governed by ${policy.fuigoPolicyPath(previous)} with a different policy`,
} });

describe("site 26 raw classification (driver fixtures are separate)", () => {
  it("T26a classifier: the recorded moved binding is recoverable", () => {
    expect(policy.fuigoPolicyRootMoved(raw(), record, relocation, current)).toBe(true);
  });
  it.each([
    ["T26c conflicting moved marker without provenance", undefined, relocation],
    ["T26d foreign recorded root", { ...record, root: "/foreign" }, relocation],
    ["T26e full hash mismatch sharing sha16", { ...record, sha256: record.sha256.slice(0, 16) + "0".repeat(48) }, relocation],
    ["no root record", record, undefined],
  ] as const)("%s", (_name, provenance, move) => {
    const wire = raw();
    if (provenance) wire.data.message = `this session is governed by ${policy.fuigoPolicyPath(provenance.root)} with a different policy`;
    expect(policy.fuigoPolicyRootMoved(wire, provenance, move, current)).toBe(false);
  });
  it.each([
    ["T26f different marker sentence", { message: "another marker" }],
    ["T26g different claim", { path: "/foreign" }],
    ["T26h session_policy_missing", { policy_error: "session_policy_missing" }],
  ] as const)("%s", (_name, patch) => {
    const error = raw(); Object.assign(error.data, patch);
    expect(policy.fuigoPolicyRootMoved(error, record, relocation, current)).toBe(false);
  });
  it("requires the exact RPC code", () => {
    expect(policy.fuigoPolicyRootMoved({ ...raw(), code: -32603 }, record, relocation, current)).toBe(false);
  });
  it.each([
    ["T26m legacy copy", undefined, "fresh"],
    ["T26m recorded copy", record, "fresh"],
    ["T26n current copy binding", { ...record, root: current }, "load"],
    ["M1 foreign copy binding", { ...record, root: "/foreign" }, "refuse"],
    ["M1 changed copy hash", { ...record, sha256: record.sha256.slice(0, 16) + "0".repeat(48) }, "refuse"],
  ] as const)("%s", (_name, provenance, expected) => {
    expect(policy.fuigoCopyPreflight(provenance, { previous, copied: true }, current)).toBe(expected);
  });
});
