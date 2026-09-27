import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compactPlaceholder } from "./composer-placeholder";

// A one-line composer on a phone clipped "Ember is working. Enter sends this
// into the running turn" mid-word. On a narrow screen the placeholder keeps
// only its lead; the whole sentence stays on a wide one. No em dash joins the
// two (0.1.60 copy rule).
it("keeps a phone's placeholder to its lead", () => {
  expect(compactPlaceholder("Ember is working", "Enter sends this into the running turn", true)).toBe("Ember is working");
  expect(compactPlaceholder("Message Launch team", "replies go to Pearl", true)).toBe("Message Launch team");
  expect(compactPlaceholder("Message Ember", undefined, true)).toBe("Message Ember");
});
it("leaves a wide screen's placeholder whole, as two sentences", () => {
  expect(compactPlaceholder("Ember is working", "sends when this turn finishes", false)).toBe("Ember is working. Sends when this turn finishes");
  expect(compactPlaceholder("Message Ember", undefined, false)).toBe("Message Ember");
  expect(compactPlaceholder("Ember is working", "Enter queues your message", false)).not.toMatch(/—/);
});
it("joins the inject hint with a full stop, never an em dash", () => {
  expect(compactPlaceholder("Finch is working", "inject now to interrupt with the queued message", false)).toBe(
    "Finch is working. Inject now to interrupt with the queued message",
  );
  const composer = readFileSync(new URL("../components/Composer.tsx", import.meta.url), "utf8");
  const hints = [...composer.matchAll(/\{ lead: `\$\{busyName\} is working`, hint: "([^"]+)" \}/g)].map((m) => m[1]);
  expect(hints).toHaveLength(4);
  for (const hint of hints) expect(hint).not.toMatch(/—/);
  expect(composer).not.toMatch(/is working —/);
});
