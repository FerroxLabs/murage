// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U05 (1.0.4, GrokBuild H1): whether an ACP engine's turn reaches Flux Router,
// decided from the host the engine really sends model requests to: an env
// override it reads, else its own config file, else the host compiled into it
// (Fuigo's compiled default IS api.fluxrouter.ai). "unknown" means Murage cannot
// tell (a custom ACP command, a config that cannot be read), and the core then
// treats the turn as reaching Flux: the memory choices ride along on an engine
// that carries them, and the turn is refused on one that cannot.
import { readFileSync, statSync } from "node:fs";

import { envReachesFlux, isFluxUrl } from "./flux-memory-headers.ts";

/** An engine whose compiled-in model host is Flux Router itself (Fuigo). */
export const COMPILED_FLUX = "compiled-flux-router" as const;

export type FluxReach = "flux" | "elsewhere" | "unknown";

type Env = Record<string, string | undefined>;

const MAX_CONFIG_BYTES = 1024 * 1024;
const URLISH = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'`<>,;)\]}]*)?/gi;

/** Whether any host named in this text is a Flux Router host (with or without a scheme). */
export function textNamesFlux(text: string): boolean {
  for (const match of text.matchAll(URLISH)) {
    const token = match[0];
    if (isFluxUrl(/^https?:\/\//i.test(token) ? token : `https://${token}`)) return true;
  }
  return false;
}

/** Scan an engine's own config files for a Flux host. A missing file is the engine's compiled
 * default (not Flux); a file that exists but cannot be read, or is too large to read, is unknown. */
export function configFilesReach(paths: readonly string[]): FluxReach {
  let unknown = false;
  for (const path of paths) {
    let text: string;
    try {
      const size = statSync(path).size;
      if (size > MAX_CONFIG_BYTES) { unknown = true; continue; }
      text = readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      unknown = true;
      continue;
    }
    if (textNamesFlux(text)) return "flux";
  }
  return unknown ? "unknown" : "elsewhere";
}

/**
 * The reach of an engine whose host is an env override, then its config files, then a compiled default.
 * `hostEnv` lists the env names the engine reads for its model host, in its own precedence order.
 */
export function engineReach(env: Env, spec: { hostEnv?: readonly string[]; configFiles?: readonly string[]; compiledDefault: string | null | typeof COMPILED_FLUX }): FluxReach {
  if (envReachesFlux(env)) return "flux";
  for (const name of spec.hostEnv ?? []) {
    const value = env[name]?.trim();
    if (value) return isFluxUrl(value) ? "flux" : "elsewhere";
  }
  const fromConfig = configFilesReach(spec.configFiles ?? []);
  if (fromConfig !== "elsewhere") return fromConfig;
  if (spec.compiledDefault === COMPILED_FLUX) return "flux";
  if (spec.compiledDefault === null) return "unknown";
  return isFluxUrl(spec.compiledDefault) ? "flux" : "elsewhere";
}
