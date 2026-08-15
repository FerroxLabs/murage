import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenCodeGoDriver, fetchOpenCodeGoModels, resetOpenCodeGoModelCache } from "./opencode-go.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("OpenCode Go catalog", () => {
  beforeEach(() => resetOpenCodeGoModelCache());

  it("normalizes valid catalog records to provider-qualified model ids", async () => {
    const models = await fetchOpenCodeGoModels(async () =>
      new Response(JSON.stringify({
        data: [
          { id: "minimax-m3", object: "model" },
          { id: "bad id", object: "model" },
          { object: "model" },
        ],
      }), { status: 200 }),
    );

    expect(models).toEqual({
      default: "opencode-go/minimax-m3",
      options: [{ id: "opencode-go/minimax-m3", label: "Minimax M3" }],
    });
  });

  it("uses the last successful catalog when the endpoint fails", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify([{ id: "kimi-k3" }]), { status: 200 });
    await fetchOpenCodeGoModels(fetcher);

    const fallback = await fetchOpenCodeGoModels(async () => {
      throw new Error("network down");
    });

    expect(fallback.default).toBe("opencode-go/kimi-k3");
  });

  it("keeps the driver optional and declares the OpenCode CLI setup", () => {
    const driver = createOpenCodeGoDriver(async () => new Response("[]", { status: 200 }));
    expect(driver.driverKind).toBe("opencodeGo");
    expect(driver.decodeConfig(undefined)).toEqual({ cli: "opencode", fullAuto: false, workspace: undefined });
    expect(driver.install?.docsUrl).toContain("opencode.ai");
  });

  it("keeps the OpenCode key in the child environment only", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-opencode-go-"));
    try {
      const dump = join(scratch, "env.json");
      const driver = createOpenCodeGoDriver(async () => new Response(JSON.stringify([{ id: "minimax-m3" }]), { status: 200 }));
      const instance = await driver.create({
        instanceId: "opencode-go",
        displayName: "OpenCode Go",
        environment: {
          OPENCODE_API_KEY: "secret-value",
          OPENAI_API_KEY: "wrong-provider-secret",
          ANTHROPIC_API_KEY: "wrong-provider-secret",
          FAKE_ACP_DUMP: dump,
        },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      await instance.snapshot();
      const child = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(child.env.OPENCODE_API_KEY).toBe("secret-value");
      expect(child.env.OPENAI_API_KEY).toBeUndefined();
      expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
      await instance.dispose();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
