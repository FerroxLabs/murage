// Spec A3: removing (or re-pointing) a user-added local server removes the
// engine entries Murage wrote for it — Pi models.json, Qwen settings.json,
// OpenCode opencode.json, Hermes config.yaml, Droid settings.json, Kimi and
// Grok config.toml, Fuigo config.toml. Each writer owns its own removal and
// only touches entries that point at this server (its id or its address);
// the user's other providers and models are left as they are.
//
// A config Murage cannot read or safely parse is REFUSED, never rewritten
// (0.1.52 A8): the file keeps its bytes and the report says so. One refusal
// does not stop the others.
import type { LocalServerCleanupReport } from "../shared/local-models.ts";
import type { LocalHost } from "./drivers/local-inject.ts";
import { NativeConfigRefusal } from "./drivers/native-config-file.ts";
import { removePiLocalHost } from "./drivers/pi.ts";
import { removeQwenLocalHost } from "./drivers/acp/qwen.ts";
import { removeOpenCodeLocalHost } from "./drivers/acp/opencode-go.ts";
import { removeHermesLocalHost } from "./drivers/acp/hermes.ts";
import { removeDroidLocalHost } from "./drivers/acp/droid.ts";
import { removeKimiLocalHost } from "./drivers/acp/kimi.ts";
import { removeGrokLocalHost } from "./drivers/acp/grok.ts";
import { removeFuigoLocalHost } from "./drivers/acp/fuigo.ts";

type Env = Record<string, string | undefined>;
type Remover = (host: LocalHost, env: Env) => "removed" | "absent";

const REMOVERS: ReadonlyArray<[engine: string, remove: Remover]> = [
  ["piAgent", removePiLocalHost],
  ["qwenAgent", removeQwenLocalHost],
  ["opencodeGo", removeOpenCodeLocalHost],
  ["hermesAgent", removeHermesLocalHost],
  ["droidAgent", removeDroidLocalHost],
  ["kimiAgent", removeKimiLocalHost],
  ["grokAgent", removeGrokLocalHost],
  ["fuigoAgent", removeFuigoLocalHost],
];

export function removeLocalHostInjections(host: LocalHost, env: Env = process.env): LocalServerCleanupReport[] {
  // Built-in loopback hosts are shared with every other app on this machine
  // and are never "removed"; only a server the user added owns its entries.
  if (host.source !== "added") return [];
  return REMOVERS.map(([engine, remove]) => {
    try {
      return { engine, status: remove(host, env) };
    } catch (error) {
      // NativeConfigRefusal messages carry only a display path and repair
      // guidance; anything else is summarized so no file content leaks.
      const message = error instanceof NativeConfigRefusal ? error.message : `Murage could not update this engine's settings; remove the "${host.id}" entry by hand.`;
      return { engine, status: "refused" as const, message };
    }
  });
}
