// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Proves the STAGED Baileys (dist-server/node_modules, exactly what the
// packaged app ships) loads, including its wasm dependency, and that its socket
// factory is callable, without ever opening a connection. Needs
// `pnpm build:server`; skipped otherwise. This is the one test allowed to
// import Baileys itself (WHATSAPP-DESIGN.md 10): the bridge core takes
// `makeSocket` by injection everywhere else.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const entry = join(root, "dist-server", "node_modules", "baileys", "lib", "index.js");

describe.skipIf(!existsSync(entry))("staged baileys runtime", () => {
  it("imports from dist-server/node_modules and exposes the factory API", async () => {
    const baileys = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    expect(typeof baileys.default).toBe("function");
    expect(baileys.makeWASocket).toBe(baileys.default);
    for (const name of ["initAuthCreds", "makeCacheableSignalKeyStore", "DisconnectReason", "Browsers", "DEFAULT_CONNECTION_CONFIG"]) {
      expect(baileys[name], name).toBeDefined();
    }
    const creds = (baileys.initAuthCreds as () => { noiseKey: unknown; registered: boolean })();
    expect(creds.noiseKey).toBeDefined();
    expect(creds.registered).toBe(false);
  });

  it("runs the real socket factory up to its pre-connect checks without connecting", async () => {
    const baileys = (await import(pathToFileURL(entry).href)) as {
      default: (config: Record<string, unknown>) => unknown;
      DisconnectReason: { loggedOut: number };
    };
    // A tcp: URL is refused by makeSocket BEFORE the WebSocket client is
    // created, so the real factory code runs (config merge, validation) and no
    // network is touched.
    let thrown: { output?: { statusCode?: number } } | undefined;
    try {
      baileys.default({ waWebSocketUrl: "tcp://127.0.0.1:1" });
    } catch (error) {
      thrown = error as typeof thrown;
    }
    expect(thrown?.output?.statusCode).toBe(baileys.DisconnectReason.loggedOut);
  });
});
