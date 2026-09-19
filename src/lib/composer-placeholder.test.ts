import { expect, it } from "vitest";
import { compactPlaceholder } from "./composer-placeholder";

// A one-line composer on a phone clipped "Ember is working — Enter sends this
// into the running turn" mid-word. On a narrow screen the placeholder keeps
// only its lead; the whole sentence stays on a wide one.
it("keeps a phone's placeholder to the part before the dash", () => {
  expect(compactPlaceholder("Ember is working — Enter sends this into the running turn", true)).toBe("Ember is working");
  expect(compactPlaceholder("Message Launch team — replies go to Pearl", true)).toBe("Message Launch team");
  expect(compactPlaceholder("Message Ember", true)).toBe("Message Ember");
});
it("leaves a wide screen's placeholder whole", () => {
  expect(compactPlaceholder("Ember is working — Enter sends this into the running turn", false)).toBe("Ember is working — Enter sends this into the running turn");
});
