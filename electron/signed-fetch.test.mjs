// Test support (not packaged, not a test): makes a fake health answer carry the proof the real child gives, so a test of the probe can stay about the probe.
import { CHALLENGE_PATTERN, computeProof, proofKeyOf } from "../shared/boot-proof.mjs";
import { launchOf, pollServerIdentity as realPoll } from "./server-boot-probe.mjs";

/** Wraps a fetch so an answer whose `launch` is the hash of `nonce` is signed over the probe's challenge and the answer's own status fields. Others stay as they are. */
export function signed(fetchImpl, nonceOf = () => "n4242") {
  return async (url, options) => {
    const nonce = nonceOf();
    const response = await fetchImpl(url, options);
    const body = await response.json();
    const challenge = options?.headers?.["x-murage-challenge"];
    if (!body || typeof body !== "object" || typeof nonce !== "string" || body.launch !== launchOf(nonce) || typeof challenge !== "string" || !CHALLENGE_PATTERN.test(challenge)) return { ...response, json: async () => body };
    const proof = computeProof(proofKeyOf(nonce), challenge, { status: response.status, pid: body.pid, launch: body.launch, isStatic: body.static === true, upgrading: body.upgrading === true });
    return { ...response, json: async () => ({ ...body, proof }) };
  };
}
/** pollServerIdentity with every fake answer signed. */
export const pollServerIdentity = (options) => realPoll(options.fetchImpl ? { ...options, fetchImpl: signed(options.fetchImpl, () => options.signAs ?? (typeof options.nonce === "function" ? options.nonce() : "n4242")) } : options);
export { launchOf };
