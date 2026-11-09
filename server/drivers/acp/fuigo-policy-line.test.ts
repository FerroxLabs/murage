// 1.0.18 FUIGO-WIN: a Fuigo turn refused before its prompt (an engine older than 1.0.36 gives no policy ack) must show the
// owner the WHOLE line in the chat. The activity row is cut at ERROR_MESSAGE_MAX, and the old line lost its advice to
// update Fuigo from Settings to that cut.
import { describe, expect, it } from "vitest";

import { ERROR_MESSAGE_MAX } from "../../../shared/provider-error.ts";
import { acpEngineErrorText } from "./core.ts";
import { FUIGO_POLICY_SHA256, FuigoPolicyError, checkFuigoPolicyAck, fuigoPolicyFailure } from "./fuigo-policy.ts";

const CODES = ["hash_mismatch", "hash_missing", "symlink", "not_found", "not_regular_file", "unreadable", "session_policy_missing", "leader_conflict", "route_refused", "session_policy_conflict", "zzzz_unknown_code_with_a_very_long_name_that_is_cut"];

function ackLine(result: unknown): string {
  try { checkFuigoPolicyAck(result, { path: "/p.toml", sha256: FUIGO_POLICY_SHA256 }); } catch (e) { return (e as Error).message; }
  throw new Error("no refusal");
}

describe("Fuigo policy refusal lines fit the chat row", () => {
  it("an engine that gives no ack: whole line inside the cap, update advice kept, nothing cut", () => {
    for (const line of [ackLine({ sessionId: "s" }), ackLine({ _meta: { "fuigo/permissionPolicy": { sha256: "0".repeat(64) } } })]) {
      expect(line.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
      expect(line).toMatch(/update Fuigo from Settings\.$/);
      expect(line).toMatch(/Nothing ran\./);
      expect(acpEngineErrorText(line)).toBe(line);
    }
    expect(ackLine({ sessionId: "s" })).toMatch(/did not confirm your approval settings/);
  });

  it("every policy_error code from the engine fits the cap too", () => {
    for (const code of CODES) {
      const failure = fuigoPolicyFailure({ data: { policy_error: code } });
      expect(failure).toBeInstanceOf(FuigoPolicyError);
      expect(failure!.message.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
      expect(acpEngineErrorText(failure!.message)).toBe(failure!.message);
    }
  });
});
