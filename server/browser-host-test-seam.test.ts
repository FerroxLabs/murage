import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { browserEngineRefusesHost } from "./testing/browser-host.ts";

// Separate Node processes prove the seam is bounded by the server process's
// environment, rather than by the input.env handed to a browser child.
const probe = (extra: NodeJS.ProcessEnv, inject = true) => {
  const source = `
    import { assertBrowserHostSandbox, BROWSER_HOST_TEST } from ${JSON.stringify(new URL("./browser-engine.ts", import.meta.url).href)};
    let calls = 0, error = null;
    ${inject ? "globalThis[BROWSER_HOST_TEST] = { assertSandbox() { calls++; } };" : ""}
    try { assertBrowserHostSandbox(); } catch (e) { error = e.message; }
    console.log(JSON.stringify({ calls, error }));
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    windowsHide: true,
    env: { ...process.env, NODE_ENV: "", MURAGE_PACKAGED: "", MURAGE_RESOURCES_PATH: "", OMB_RESOURCES_PATH: "", ...extra },
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim()) as { calls: number; error: string | null };
};

it("an injected fake browser host is available in an unpackaged test process", () => {
  expect(probe({ NODE_ENV: "test" })).toEqual({ calls: 1, error: null });
});

it.each([
  ["production", { NODE_ENV: "production" }],
  ["unset NODE_ENV", {}],
  ["packaged", { NODE_ENV: "test", MURAGE_PACKAGED: "1" }],
  ["Murage resources", { NODE_ENV: "test", MURAGE_RESOURCES_PATH: "/fixture/resources" }],
  ["legacy resources", { NODE_ENV: "test", OMB_RESOURCES_PATH: "/fixture/resources" }],
] as const)("the fake browser host is unreachable in %s", (_name, env) => {
  const result = probe(env);
  expect(result.calls).toBe(0);
  if (browserEngineRefusesHost) expect(result.error).toBe("The browser engine requires a sandbox-capable non-container host");
});

it("an ordinary test process still enforces the real container-host rejection", () => {
  const result = probe({ NODE_ENV: "test" }, false);
  expect(result.calls).toBe(0);
  if (browserEngineRefusesHost) expect(result.error).toBe("The browser engine requires a sandbox-capable non-container host");
});
