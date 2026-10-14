// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A TypeScript program over in-memory files that import the real server modules, for tests that prove a piece of code does NOT type-check
// (server/bot-egress.types.test.ts). `files` maps an absolute path under the server directory to its source.
import ts from "typescript";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export function virtualProgram(files: Record<string, string>): ts.Program {
  const configPath = join(SERVER_DIR, "..", "tsconfig.server.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false, noUnusedLocals: false, noUnusedParameters: false, types: ["node"] };
  const host = ts.createCompilerHost(options);
  const norm = (name: string): string => name.replace(/\\/g, "/");
  const readFile = host.readFile.bind(host), exists = host.fileExists.bind(host), getSource = host.getSourceFile.bind(host);
  host.fileExists = name => norm(name) in files || exists(name);
  host.readFile = name => files[norm(name)] ?? readFile(name);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => files[norm(name)] !== undefined
    ? ts.createSourceFile(name, files[norm(name)], languageVersion, true) : getSource(name, languageVersion, onError, shouldCreate);
  return ts.createProgram({ rootNames: Object.keys(files), options, host });
}

/** The diagnostics in one virtual file, as short strings. */
export function diagnosticsFor(program: ts.Program, file: string): string[] {
  const source = program.getSourceFile(file);
  if (!source) return [`(file not found: ${file})`];
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map(d => `${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 160)}`);
}
