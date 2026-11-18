import { describe, expect, it } from "vitest";
import { monotone } from "./testing/provider-secret-assertions.ts";
import { scanSecretText } from "./md-secret-label.mjs";
import { redactSecrets, redactSecretsForSink, redactSecretsForSinkWalk, redactSecretsInText, scanTurnText } from "../server/redact.ts";
import { scrubSecrets as preview } from "../src/lib/screen-envelope.ts";
import { scrubFeedbackText } from "../server/feedback-relay.ts";
import { redact as gateway } from "../server/model-gateway.ts";
import { redactLearningText } from "../server/memory/prospect-text.ts";
import { redact as homeLogs } from "../cloudflare/control-plane/src/self-service.ts";
import { scrubSecrets as feedback } from "../cloudflare/control-plane/src/owner-feedback.ts";

// Invented, deliberately repetitive material; never provisioned credentials.
const fixtures = [
  ["AWS temporary ID", "AS" + "IA" + "FAKE".repeat(4)],
  ["AWS long-lived ID", "AK" + "IA" + "FAKE".repeat(4)],
  ["Notion legacy", "sec" + "ret_" + "Ab3Cd5Ef7".repeat(4) + "Gh9Jk2L"],
  ["Notion current", "nt" + "n_" + "12345678901" + "Ab3Cd5E".repeat(5)],
  ["Perplexity", "pp" + "lx-" + "a1b2c3d4".repeat(6)],
] as const;
const session = "IQ" + "oJb3JpZ2luX2Vj" + "Ab3Cd5Ef7+/".repeat(28) + "==";
const sessionFields = ["AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "SessionToken", "X-Amz-Security-Token"];
const masks = [
  ["chat text", redactSecretsInText], ["logs", redactSecretsForSink],
  ["shared detector", (s: string) => scanSecretText(s).text],
  ["turn detector", (s: string) => scanTurnText(s).text],
  ["feedback relay", scrubFeedbackText], ["model gateway", (s: string) => gateway(s, [])],
  ["feedback preview", preview], ["feedback storage", feedback],
] as const;
const placements: readonly [string, (s: string) => string][] = [
  ["bare", s => `before ${s} after`],
  ["markdown", s => `**Result**: ${s}`],
  ["inline code", s => `Use \`${s}\` here`],
  ["code block", s => `\`\`\`text\n${s}\n\`\`\``],
  ["URL query", s => `https://example.invalid/?result=${s}&page=next`],
  ["JSON body", s => JSON.stringify({ result: s })],
  ["env line", s => `RESULT=${s}`],
];

describe("shared vendor secret masking", () => {
  for (const [kind, value] of fixtures) {
    for (const [place, wrap] of placements) for (const [sink, mask] of masks) {
      it(`${kind}: ${place} in ${sink}`, () => {
        const input = wrap(value), out = mask(input);
        expect(out).not.toContain(value);
        expect(out).not.toContain(value.slice(-8));
        expect(out).toMatch(/redacted|removed/);
        expect(mask(out)).toBe(out);
      });
    }
    it(`${kind}: chat, tool, nested JSON and env-array values`, () => {
      const input = { chat: `Result ${value}`, tool: { output: value }, body: { result: value }, env: [{ name: "RESULT", value }] };
      for (const walk of [redactSecrets, redactSecretsForSinkWalk]) {
        const out = JSON.stringify(walk(input));
        expect(out).not.toContain(value);
        expect(out).not.toContain(value.slice(-8));
        expect(out).toContain("redacted");
      }
    });
    it(`${kind}: folded values keep no suffix`, () => {
      for (const eol of ["\n", "\r\n"]) for (const indent of ["", "  "]) for (const [sink, mask] of masks) {
        const split = value.length - 8, tail = value.slice(split), input = value.slice(0, split) + eol + indent + tail;
        const out = mask(input);
        expect(out, sink).not.toContain(tail);
        expect(out, sink).toMatch(/redacted|removed/);
      }
    });
  }
  for (const field of sessionFields) for (const [sink, mask] of masks) {
    it(`AWS session: ${field} in ${sink}`, () => {
      for (const [place, wrap] of placements) {
        const input = wrap(`${field}=${session}`), out = mask(input);
        expect(out, place).not.toContain(session);
        expect(out, place).not.toContain(session.slice(-8));
        expect(out, place).toMatch(/redacted|removed/);
      }
      const tail = session.slice(-40);
      for (const indent of ["", "  "]) {
        const folded = `${field}=${session.slice(0, -40)}\n${indent}${tail}`;
        expect(mask(folded)).not.toContain(tail);
        // MAIN RULING 1114-UPMASK-V2-AMEND2 B2: monotone re-application;
        // unchanged base rendering may add formatting spaces or mask more.
        const first = mask(folded), second = mask(first);
        monotone(first, second, true);
        for (let at = 0; at + 8 <= session.length; at++) expect(second).not.toContain(session.slice(at, at + 8));
      }
      expect(mask(JSON.stringify({ [field]: session }))).not.toContain(session);
    });
  }
  it("AWS session: URL escaping and JSON/env shapes", () => {
    for (const [, mask] of masks) {
      expect(mask(`https://example.invalid/?X-Amz-Security-Token=${encodeURIComponent(session)}&page=next`)).not.toContain(encodeURIComponent(session));
    }
    for (const walk of [redactSecrets, redactSecretsForSinkWalk]) {
      expect(JSON.stringify(walk({ SessionToken: session, env: [{ name: "AWS_SESSION_TOKEN", value: session }] }))).not.toContain(session);
    }
  });
  const ordinary = [
    "ASIA ASIATIC Asia ASIAword", "a notion and a secret_recipe for people", "pplx-70b-online ntn_helper secret_setting",
    "secret_supercalifragilisticexpialidocious", "ntn_supercalifragilisticexpialidocious",
    "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5", "a1b2c3d4".repeat(8),
    "AWS_SESSION_TOKENIZER=ordinary", "SessionTokens=ordinary", "SessionTokenCount=1234",
    "AS" + "IA" + "A".repeat(15), "AS" + "IA" + "A".repeat(17),
    "xAS" + "IA" + "A".repeat(16), "AS" + "IA" + "a".repeat(16),
    "nt" + "n_" + "a".repeat(12), "sec" + "ret_" + "a".repeat(12), "pp" + "lx-" + "a".repeat(12),
    session, // Unlabelled base64 has no public, stable AWS-specific signature.
  ];
  for (const [sink, mask] of masks) it(`ordinary text stays readable in ${sink}`, () => {
    for (const input of ordinary) expect(mask(input), input).toBe(input);
  });
});

// Streaming boundaries must use the same provider registry as complete text.
import { createTurnTextPolicy, type ManifestBatch, type TurnAdmission } from "../server/redact-turn.ts";
for (const [kind, value] of [...fixtures, ["AWS session", `AWS_SESSION_TOKEN=${session}`]]) {
  it(`${kind}: every delta split in chat and tool streams`, () => {
    for (const stream of ["assistant", "tool"]) for (let at = 0; at <= value.length; at++) {
      const policy = createTurnTextPolicy(), admission = {} as TurnAdmission;
      policy.admit(admission);
      const batch = (text: string): ManifestBatch => ({
        envelope: { eventId: "fixture", instanceId: "fixture", threadId: "fixture", generation: 1, intakeOrdinal: 1, createdAt: 0 },
        variant: "M15", carriers: [{ text, stream, path: "text", mode: "delta" }], controls: {},
      });
      const decisions = [policy.consume(admission, batch(value.slice(0, at))), policy.consume(admission, batch(value.slice(at))), policy.finish(admission, "complete")];
      expect(decisions.some(d => d.masked), `${stream}/${at}`).toBe(true);
      expect(decisions.flatMap(d => d.operations).map(op => op.text).join("")).not.toContain(value.slice(-8));
    }
  });
}

for (const [sink, mask] of [["learning evidence", redactLearningText], ["home logs", homeLogs]] as const) {
  for (const [kind, value] of [...fixtures, ["AWS session", `SessionToken=${session}`]]) {
    it(`${kind}: ${sink} uses the shared vendor mask`, () => {
      const tail = value.slice(-8);
      expect(mask(value)).not.toContain(tail);
      expect(mask(value.slice(0, -8) + "\n  " + tail)).not.toContain(tail);
    });
  }
}

for (const [kind, value] of [...fixtures, ["AWS session", `SessionToken=${session}`]]) {
  it(`${kind}: folded delta values never release a raw fragment`, () => {
    for (const indent of ["", "  "]) {
      const wrapped = value.slice(0, -8) + "\n" + indent + value.slice(-8);
      for (let at = 0; at <= wrapped.length; at++) {
        const policy = createTurnTextPolicy(), admission = {} as TurnAdmission;
        policy.admit(admission);
        const batch = (text: string): ManifestBatch => ({
          envelope: { eventId: "fixture", instanceId: "fixture", threadId: "fixture", generation: 1, intakeOrdinal: 1, createdAt: 0 },
          variant: "M15", carriers: [{ text, stream: "assistant", path: "text", mode: "delta" }], controls: {},
        });
        const decisions = [policy.consume(admission, batch(wrapped.slice(0, at))), policy.consume(admission, batch(wrapped.slice(at))), policy.finish(admission, "complete")];
        const released = decisions.flatMap(d => d.operations).map(op => op.text).join("");
        expect(decisions.some(d => d.masked), `${indent.length}/${at}`).toBe(true);
        expect(released, `${indent.length}/${at}`).not.toContain(value.slice(-8));
        expect(released, `${indent.length}/${at}`).not.toContain(value.slice(0, 8));
      }
    }
  });
}
