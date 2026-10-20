import { lstatSync } from "node:fs";

/** The browser engine refuses root and container hosts on Linux (browser-engine.ts,
 * agentBrowserIntegration), so a turn there runs without the browser tool and a
 * test that needs the mount cannot pass. The product behaviour is deliberate;
 * these tests run on a non-container Linux, macOS and Windows. Kept apart from
 * index-harness.ts because importing that harness starts its own server. */
export const browserEngineRefusesHost = process.platform === "linux"
  && (process.getuid?.() === 0 || ["/.dockerenv", "/run/.containerenv"].some((file) => { try { return lstatSync(file).isFile(); } catch { return false; } }));
