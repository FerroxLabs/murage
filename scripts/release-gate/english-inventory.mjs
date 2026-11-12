// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source literals retain interpolation expressions so manual commands are exact.
export function englishLiterals(source) {
  const tokens = source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g) ?? [];
  return [...new Set(tokens.filter(s => !s.startsWith('//') && !s.startsWith('/*') && (/[a-zA-Z]{2,}[ -][a-zA-Z]{2,}/.test(s) || s.startsWith('`'))))].sort();
}
