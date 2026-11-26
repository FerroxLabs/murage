// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN ruling 1114-WG-SHIM-TIMING keeps the 10 ms fast-path limit. On Git Bash every fork/exec costs milliseconds, so the
// shim's fast path must not start one: no command substitution, pipeline or external binary in any shim script. The one
// substitution fallback (one exact line in wg_fmt, for shells without printf -v) never runs under bash.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const FILES = ['guard.sh', 'guard-lib.sh', 'guard-request.sh'];
const EXTERNAL = ['date', 'cat', 'grep', 'egrep', 'fgrep', 'sed', 'tr', 'basename', 'dirname', 'awk', 'head', 'tail', 'cut', 'expr', 'sleep', 'env', 'uname', 'ls', 'readlink', 'realpath', 'stat', 'test', 'id', 'wc', 'sort', 'xargs', 'printenv', 'pwd', 'cygpath', 'which', 'mktemp', 'touch'];
const ALLOWED_SUBSTITUTION = { fn: 'wg_fmt', line: 'wg_fmt_out=$(printf "$@")' };
const source = (name: string) => readFileSync(new URL(`./shim/${name}`, import.meta.url), 'utf8');

/** Process-starting constructs in one shell source. A comment line and single-quoted text are not code. */
export function externalCalls(name: string, text: string): string[] {
  const found: string[] = [];
  let fn = '';
  text.split('\n').forEach((raw, index) => {
    const opened = /^(wg_\w+)\(\) \{/.exec(raw);
    if (opened) fn = opened[1];
    else if (/^\}/.test(raw)) fn = '';
    if (/^\s*#/.test(raw)) return;
    const line = raw.replace(/'[^']*'/g, "''").replace(/\s#.*$/, '');
    const where = `${name}:${index + 1}${fn ? ` (${fn})` : ''}`;
    if (/\$\((?!\()/.test(line) || line.includes('`')) { if (fn !== ALLOWED_SUBSTITUTION.fn || raw.trim() !== ALLOWED_SUBSTITUTION.line) found.push(`${where}: command substitution`); }
    if (/\s\|\s/.test(line.replace(/\|\|/g, ''))) found.push(`${where}: pipeline`);
    for (const tool of EXTERNAL) {
      if (new RegExp(`(^|[;&|({]|\\bthen\\b|\\bdo\\b|\\belse\\b)\\s*(?:(?:command|exec)\\s+)?(?:(?:""|[\\w.-])*/)*${tool}(\\s|$)`).test(line.replace(/"[^"]*"/g, '""'))) found.push(`${where}: external ${tool}`);
    }
  });
  return found;
}

it('T-WG-FAST-PATH-STATIC: no shim script starts a process except the one non-bash printf fallback', () => {
  for (const name of FILES) expect(externalCalls(name, source(name)), name).toEqual([]);
  const request = source('guard-request.sh');
  expect(request).toMatch(/wg_fmt\(\) \{[\s\S]*?printf -v "\$wg_fmt_var" "\$@"/);
  expect(request.match(/\$\(printf/g)).toHaveLength(1);
});

it('T-WG-FAST-PATH-LEAN: path resolution and argv scanning are parsed only on demand', () => {
  const lib = source('guard-lib.sh'), request = source('guard-request.sh');
  for (const fn of ['wg_canon', 'wg_target', 'wg_argv', 'wg_children', 'wg_select_child']) {
    expect(lib, fn).not.toContain(`${fn}() {`);
    expect(request, fn).toContain(`${fn}() {`);
  }
  // wg_device stays in the always-loaded library: the device witnesses source guard-lib.sh alone.
  expect(lib).toContain('wg_device() {');
  const main = lib.slice(lib.indexOf('wg_main() {'));
  expect(main.indexOf('wg_plain_rm "$@"')).toBeGreaterThan(-1);
  // The on-demand load now falls back through the refusal of a check that cannot finish (wg_unchecked), then the tool.
  const load = 'wg_load_request || wg_unchecked "$@" || wg_exec';
  expect(main.indexOf(load)).toBeGreaterThan(-1);
  expect(main.indexOf('wg_plain_rm "$@"')).toBeLessThan(main.indexOf(load));
  expect(main.indexOf(load)).toBeLessThan(main.indexOf('wg_argv "$@"'));
});

it.each([
  ['guard-request.sh', 'wg_argv() {', 'wg_argv() {\n    wg_now=$(date +%s)'],
  ['guard-request.sh', 'wg_canon() {', 'wg_canon() {\n    printf x | grep x'],
  ['guard-lib.sh', 'wg_plain_rm() {', 'wg_plain_rm() {\n    wg_now=`date`'],
  ['guard-lib.sh', 'wg_main() {', 'wg_main() {\n    wg_now=$(date +%s)'],
  ['guard-lib.sh', 'wg_main() {', 'wg_main() {\n    wg_now=`date`'],
  ['guard-lib.sh', 'wg_main() {', 'wg_main() {\n    cat "$MURAGE_WIPE_GUARD" > /dev/null'],
  ['guard-lib.sh', 'wg_main() {', 'wg_main() {\n    printf x | grep x'],
  ['guard.sh', 'wg_tool=${0##*/}', 'wg_tool=$(basename "$0")'],
  ['guard-request.sh', 'wg_octet() {', 'wg_octet() {\n    wg_x=$(printf x)'],
  // Review gaps: a tool named by absolute path or behind `command`/`exec`, and substitutions riding on the wg_fmt allowance.
  ['guard-lib.sh', 'wg_main() {', 'wg_main() {\n    /usr/bin/date +%s > /dev/null'],
  ['guard-lib.sh', 'wg_main() {', 'wg_main() {\n    command date +%s > /dev/null'],
  ['guard-lib.sh', 'wg_main() {', 'wg_main() {\n    "$wg_piece"/cat "$MURAGE_WIPE_GUARD" > /dev/null'],
  ['guard-request.sh', 'wg_fmt_var=$1; shift', 'wg_fmt_var=$1; shift\n    wg_now=$(date +%s)'],
  ['guard-request.sh', 'wg_fmt_out=$(printf "$@")', 'wg_fmt_out=$(printf "$@")\n        wg_extra=$(printf x)'],
  ['guard-request.sh', 'wg_fmt_out=$(printf "$@")', 'wg_fmt_out=$(cat "$wg_fmt_var")'],
  ['guard-request.sh', 'wg_octet() {', 'wg_x=$(printf x)\nwg_octet() {'],
])('T-WG-FAST-PATH-STATIC mutant: %s reintroduces an external call and goes red', (file, anchor, replacement) => {
  const text = source(file);
  expect(text).toContain(anchor);
  expect(externalCalls(file, text.replace(anchor, replacement)).length).toBeGreaterThan(0);
});
