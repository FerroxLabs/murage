import { expect, it } from "vitest";
import { createSseParser } from "./model-gateway-translate.ts";

it("propagates a consuming writer refusal instead of swallowing it as malformed JSON", () => {
  const refusal = new Error("MEMORY_CONTEXT_REVOKED");
  const parser = createSseParser(() => { throw refusal; });
  expect(() => parser.push('data: {"ok":true}\n\n')).toThrow(refusal);
});
