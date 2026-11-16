import { describe, expect, it } from "vitest";
import { redactLearningText, baseLearningText } from "../server/memory/prospect-text.ts";
import { redact as gateway, baseRedact as baseGateway } from "../server/model-gateway.ts";
import { scanSecretText } from "./md-secret-label.mjs";
import { redactEngineDiagnosticCredentials, redactSecretsForSink, redactSecretsInText, scanTurnText } from "../server/redact.ts";
import { scrubSecrets as preview } from "../src/lib/screen-envelope.ts";
import { scrubFeedbackText } from "../server/feedback-relay.ts";
import { scrubSecrets as feedback, baseScrubSecrets as baseFeedback } from "../cloudflare/control-plane/src/owner-feedback.ts";

// Repetitive, invented material, assembled at runtime; never issued keys.
const children = [
  ["temporary AWS", "AS" + "IA" + "C".repeat(16)],
  ["long-lived AWS", "AK" + "IA" + "C".repeat(16)],
  ["current Notion", "nt" + "n_" + "C".repeat(46)],
  ["legacy Notion", "sec" + "ret_" + "C".repeat(43)],
  ["Perplexity", "pp" + "lx-" + "C".repeat(32)],
] as const;
const fixtures = [
  ...children.slice(0, 2).map(([name, child]) => [
    `SendGrid / ${name}`, "SG" + "." + "A".repeat(22) + "." + "B".repeat(22) + "-" + child,
  ] as const),
  ...children.map(([name, child]) => [
    `PyPI / ${name}`, "py" + "pi-" + "AgE" + "B".repeat(82) + "-" + child,
  ] as const),
];
const masks = [
  // MAIN RULING 1114-UPMASK-V2-EXPECTATIONS: standalone helper removed; all caller rows retained.
  ["chat", redactSecretsInText], ["machine logs", redactSecretsForSink],
  ["engine diagnostic", redactEngineDiagnosticCredentials],
  ["shared detector", (s: string) => scanSecretText(s).text],
  ["turn detector", (s: string) => scanTurnText(s).text],
  ["feedback preview", preview], ["feedback relay", scrubFeedbackText],
  ["feedback storage", feedback],
] as const;

describe("whole provider credentials containing another vendor prefix", () => {
  for (const [name, value] of fixtures) for (const [sink, mask] of masks) {
    it(`${name} is removed whole in ${sink}`, () => {
      const out = mask(`before ${value} after`);
      // MAIN RULING 1114-UPMASK-V2-AMEND2 B3: storage's release base has no SG/PyPI rule.
      if (sink === "feedback storage") {
        const input = `before ${value} after`;
        const child = children.find(([, child]) => value.endsWith(child))![1];
        const prefix = value.slice(0, -child.length);
        expect(baseFeedback(prefix)).toBe(prefix);
        expect(baseFeedback(input)).toBe(child.startsWith("AK" + "IA") ? `before ${prefix}[removed] after` : input);
        expect(out).toBe(`before ${value.slice(0, -child.length)}[removed] after`);
        expect(mask(out)).toBe(out);
        return;
      }
      expect(out).toMatch(/^before (?:«redacted(?: \d+ chars)?»|\[removed\]) after$/);
      expect(out).not.toContain("A".repeat(22));
      expect(out).not.toContain("B".repeat(22));
      expect(mask(out)).toBe(out);
    });
  }
  it("keeps Basic extent edits relative to the original overlapping credential", () => {
    const value = fixtures[0][1];
    for (const mask of [redactSecretsInText, redactSecretsForSink, preview]) {
      const out = mask(`Authorization: Basic ${value} trailing-material`);
      expect(out).not.toContain("trailing-material");
      expect(out).not.toContain("A".repeat(22));
      expect(out).not.toContain("B".repeat(22));
    }
  });
  it("does not mask ordinary provider names or short lookalikes", () => {
    const ordinary = "SendGrid SG.sample PyPI pypi-guide ASIA-region ntn_notes pplx-sonar";
    for (const [, mask] of masks) expect(mask(ordinary)).toBe(ordinary);
  });
});

// MAIN RULING 1114-UPMASK-V2-AMEND2 B3: these release-base callers do not
// recognize enclosing SG/PyPI shapes; keep their public prefix and hide the
// vendor child, preserving any mask the base already emitted for that child.
for (const [name, base, mask, marker] of [
  ["storage", baseFeedback, feedback, "[removed]"],
  ["learning", baseLearningText, redactLearningText, "[secret]"],
  ["gateway", (s: string) => baseGateway(s, []), (s: string) => gateway(s, []), "[redacted]"],
] as const) it(`${name} preserves base behavior for absent legacy providers`, () => {
  for (const [, value] of fixtures) {
    const child = children.find(([, child]) => value.endsWith(child))![1];
    const prefix = value.slice(0, -child.length);
    expect(base(prefix)).toBe(prefix);
    expect(mask(value)).toBe(prefix + marker);
    if (base(value) !== value) expect(mask(value)).toBe(base(value));
  }
});
