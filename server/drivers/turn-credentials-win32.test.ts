// Windows refuses to rename onto a file that another process holds open. The
// credential store must still land the body (an empty one revokes the turn).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const rename = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (rename.code && (actual.existsSync(to))) throw Object.assign(new Error(rename.code), { code: rename.code });
      return actual.renameSync(from, to);
    },
  };
});

import { createTurnCredentialStore } from "./turn-credentials.ts";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const platform = (value: string) => Object.defineProperty(process, "platform", { ...realPlatform, value });

describe("credential store when the rename is refused", () => {
  const stores: ReturnType<typeof createTurnCredentialStore>[] = [];
  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    rename.code = null;
    for (const store of stores.splice(0)) store.dispose();
  });
  const make = () => { const store = createTurnCredentialStore(); stores.push(store); return store; };

  it("on win32 writes in place when the file is held open (EPERM), leaving no .tmp behind", () => {
    platform("win32");
    const store = make();
    rename.code = "EPERM";
    store.write({ a: { MURAGE_MCP_TOKEN: "t" } });
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({ a: { MURAGE_MCP_TOKEN: "t" } });
    store.clear();
    expect(readFileSync(store.path, "utf8")).toBe("{}");
    expect(() => readFileSync(`${store.path}.tmp`)).toThrow();
  });

  it("elsewhere the failure still surfaces, so the driver recycles the process", () => {
    platform("linux");
    const store = make();
    rename.code = "EPERM";
    expect(() => store.clear()).toThrow();
  });

  it("on win32 an unrelated failure still surfaces", () => {
    platform("win32");
    const store = make();
    rename.code = "ENOSPC";
    expect(() => store.clear()).toThrow();
  });
});
