// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import path from "node:path";
import ts from "typescript";
import { SERVER_DIR } from "../../testing/virtual-program.ts";

/** Overlay virtual Signal sources on the real compiler host. */
export function virtualCompilerHost(
  files: Record<string, string>,
  options: ts.CompilerOptions,
  paths: Pick<typeof path, "resolve" | "sep"> = path,
): ts.CompilerHost {
  const normalize = (name: string): string => {
    const resolved = paths.resolve(name.replace(/\\/g, "/")).replace(/\\/g, "/");
    return paths.sep === "\\" ? resolved.toLowerCase() : resolved;
  };
  // Normalize stored keys as well as requests: TypeScript may resolve, change
  // separators, or change casing before asking the host for a virtual source.
  const sources = new Map(Object.entries(files).map(([name, source]) => [normalize(name), source]));
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = name => sources.has(normalize(name)) || fileExists(name);
  host.readFile = name => sources.get(normalize(name)) ?? readFile(name);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    const source = sources.get(normalize(name));
    return source !== undefined
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreate);
  };
  return host;
}

/** Compile virtual contract fixtures against the real server configuration. */
export function virtualProgram(files: Record<string, string>): ts.Program {
  const configPath = path.join(SERVER_DIR, "..", "tsconfig.server.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  const options: ts.CompilerOptions = {
    ...parsed.options, noEmit: true, incremental: false,
    noUnusedLocals: false, noUnusedParameters: false, types: ["node"],
  };
  const rootNames = Object.keys(files).map(name => path.resolve(name.replace(/\\/g, "/")).replace(/\\/g, "/"));
  return ts.createProgram({ rootNames, options, host: virtualCompilerHost(files, options) });
}
