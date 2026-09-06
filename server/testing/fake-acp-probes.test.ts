import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it.each([
  { args: ["--version"], expected: "fake-acp 1.0.0\n" },
  { args: ["status", "--format", "json"], expected: '{"isAuthenticated":false}\n' },
  { args: ["models"], expected: "cursor-live - Cursor Live\n" },
])("flushes delayed stdout before the $args probe exits", ({ args, expected }) => {
  const fixture = new URL("./fake-acp-cli.ts", import.meta.url).href;
  const source = `
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...args) => {
      setTimeout(() => originalWrite(...args), 50);
      return true;
    };
    process.argv = [process.execPath, "fixture", ...${JSON.stringify(args)}];
    await import(${JSON.stringify(fixture)});
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 5_000,
    env: { ...process.env, FAKE_ACP_AUTH: "0", FAKE_ACP_MODELS: "" },
  });
  expect(stdout).toContain(expected);
});
