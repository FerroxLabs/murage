import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { newSendId } from "./send-id";

afterEach(() => { vi.unstubAllGlobals(); });

describe("message send IDs", () => {
  it("uses the native method with its required receiver on secure origins", () => {
    const native = {
      randomUUID() {
        expect(this).toBe(native);
        return "11111111-1111-4111-8111-111111111111";
      },
    };
    vi.stubGlobal("crypto", native);
    expect(newSendId()).toBe("11111111-1111-4111-8111-111111111111");
  });

  it.each([0, 255])("sets only the UUID version/variant bits for random byte %i", (value) => {
    const fallback = {
      getRandomValues(bytes: Uint8Array) {
        expect(this).toBe(fallback);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.byteLength).toBe(16);
        return bytes.fill(value);
      },
    };
    vi.stubGlobal("crypto", fallback);
    expect(newSendId()).toBe(value === 0
      ? "00000000-0000-4000-8000-000000000000"
      : "ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("uses fresh cryptographic bytes for independent sends without randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const ids = Array.from({ length: 1000 }, () => newSendId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("does not silently substitute predictable IDs when crypto is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    expect(newSendId).toThrow("supported browser");
  });
});
