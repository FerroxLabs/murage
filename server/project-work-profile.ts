// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { directory } from "./project-folder-leases.ts";
import { isOwnWorkspaceFileTool, within } from "./own-workspace-approval.ts";
export interface ProjectWorkRoot { path: string; dev: string; ino: string; label?: string }
export type EffectiveProjectProfile = "ask" | "auto-in-roots" | "engine";
export function canonicalProjectRoots(roots: Array<{ path: string; label?: string }>, options: { dataDir: string }): ProjectWorkRoot[] {
  if (roots.length > 8) throw new Error("Choose up to eight work folders.");
  return roots.map(root => {
    if (!isAbsolute(root.path) || (root.label?.length ?? 0) > 60) throw new Error("Choose a folder with a label of up to 60 characters.");
    const current = directory(root.path); const path = current.canonicalPath;
    let home = homedir(); try { home = directory(home).canonicalPath; } catch { /* exact lexical home still refused */ }
    let data = options.dataDir; try { data = directory(data).canonicalPath; } catch { /* a missing data dir still has a lexical path */ }
    const parent = statSync(dirname(path), { bigint: true });
    const mounted=process.platform === "linux" && readFileSync("/proc/self/mountinfo","utf8").split("\n").some(line=>line.split(" ")[4]?.replace(/\\([0-7]{3})/g,(_all,octal:string)=>String.fromCharCode(parseInt(octal,8)))===path);
    if (mounted || path === parse(path).root || path === home || path === data || within(data,path,false) || within(path,data,false)
      || /^\/Volumes\/[^/]+$/.test(path) || parent.dev.toString() !== current.dev || parent.ino.toString() === current.ino) throw new Error("Choose a work folder inside your home or drive, outside Murage's data folder.");
    return { path, dev: current.dev, ino: current.ino, ...(root.label ? { label: root.label } : {}) };
  });
}
export function effectiveProjectProfile(profile: string, enabled: boolean, engine: string, raw: unknown, enforcement: { routeAsks?: true; stopLine?: true } = {}): EffectiveProjectProfile {
  const askingProfile = enabled && profile === "auto-in-roots" ? "auto-in-roots" : "ask";
  const config = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const skipAll = config.fullAuto === true && !enforcement.routeAsks && !enforcement.stopLine;
  if (engine === "claude") return config.permissionMode === "default" ? askingProfile : "engine";
  if (engine === "piAgent") return skipAll ? "engine" : askingProfile;
  // Only engines whose structured file asks are supported, in a asking mode.
  if (["fuigoAgent", "geminiAgent", "kimiAgent", "qwenAgent", "hermesAgent", "grokAgent", "opencodeGo"].includes(engine)
    && !skipAll && !["auto","bypassPermissions","acceptEdits","yolo"].includes(String(config.mode ?? config.permissionMode ?? ""))) return askingProfile;
  return "engine";
}
export function projectFileApproval(input: { tool: unknown; paths?: readonly string[]; roots: readonly ProjectWorkRoot[]; deskRoots?: readonly string[]; ownerAudience: boolean; effectiveProfile: EffectiveProjectProfile }): boolean {
  if (!input.ownerAudience || input.effectiveProfile !== "auto-in-roots" || !isOwnWorkspaceFileTool(input.tool) || !input.paths?.length) return false;
  const roots = input.roots.filter(root => {
    try { const current = directory(root.path); return current.canonicalPath === root.path && current.dev === root.dev && current.ino === root.ino; } catch { return false; }
  }).map(root => root.path);
  const desks=(input.deskRoots??[]).filter(root=>{try{return directory(root).canonicalPath===resolve(root);}catch{return false;}});
  return input.paths.every(path => roots.some(root => within(root,path,false)) || desks.some(root => within(root,path,true)));
}
