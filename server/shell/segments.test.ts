// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { segments } from './segments.ts';
import { lex, lexWordText, renderWord, MAX_TEXT_CHARS } from './lex.ts';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { segmentDesignRows } from '../testing/no-limits-segment-design-cases.ts';

const commands = (text: string) => segments(text).segments.filter(s => s.words.length).map(s => s.words.map(w => w.text));
describe('one source-aware segment lexer', () => {
  it.each(['";"', "';'", '\\;', '"&&"', '"|"', "'\n'"])('L1 quoted operator %s stays a word', raw => {
    expect(commands(`tee ${raw} /etc/x`)).toEqual([['tee', raw === "'\n'" ? '\n' : raw.includes('&&') ? '&&' : raw.includes('|') ? '|' : ';', '/etc/x']]);
  });
  it('L2 newline separates without spaces; continuation disappears', () => {
    expect(commands('set --\ntar -xf a')).toEqual([['set', '--'], ['tar', '-xf', 'a']]);
    expect(commands('to\\\nuch ./x')).toEqual([['touch', './x']]);
  });
  it('L3 nested executable text and quote removal', () => {
    const result = segments('echo "a\\\"b" $(tee /etc/a) `touch /etc/b` > >(tee /etc/c)');
    expect(result.segments.flatMap(s => s.words.map(w => w.text))).toContain('a"b');
    expect(result.segments.filter(s => s.depth === 1).flatMap(s => s.words.map(w => w.text))).toEqual(['tee', '/etc/a', 'touch', '/etc/b', 'tee', '/etc/c']);
    expect(result.segments[0]!.words[2]!.origin).toBe('expansion');
  });
  it('L4 a comment ends at newline but hash inside a word is literal', () => {
    expect(commands('echo x#y # touch /etc/x\ntee ./out')).toEqual([['echo', 'x#y'], ['tee', './out']]);
  });
  it('L5 heredoc data stays data and missing terminators consume to EOF', () => {
    for (const text of ["cat <<'EOF'\ntouch /etc/x\nEOF", 'cat <<EOF\ntouch /etc/x']) {
      const result = segments(text);
      expect(result.segments.flatMap(s => s.words.map(w => w.text))).toEqual(['cat']);
      expect(result.segments[0]!.redirects[0]!.heredoc!.body).toMatch(/^touch \/etc\/x/);
    }
  });
  it('L5 shell-consumed heredoc executes once; tab-stripping and queued bodies', () => {
    const result = segments("bash <<-'A' <<'B'\n\ttouch /etc/a\n\tA\ntee /etc/b\nB");
    expect(result.segments.filter(s => s.via === 'heredoc-code').flatMap(s => s.words.map(w => w.text))).toEqual(['tee', '/etc/b']); // MAIN r2 L5: the last fd-0 redirect wins; A is data.
  });
  it('L5 unquoted body executes substitutions only', () => {
    const text = 'cat <<EOF\ntouch /etc/data\n$(touch /etc/sub) `tee /etc/back`\nEOF';
    expect(segments(text).segments.filter(s => s.depth > 0).flatMap(s => s.words.map(w => w.text))).toEqual(['touch', '/etc/sub', 'tee', '/etc/back']);
    expect(segments(text.replace('<<EOF', "<<'EOF'")).segments.filter(s => s.depth > 0)).toEqual([]);
  });
  it('L6 shell here-string executes; ordinary here-string is data', () => {
    expect(segments("bash <<< 'touch /etc/x'").segments.some(s => s.via === 'heredoc-code')).toBe(true);
    expect(commands("cat <<< 'touch /etc/x'")).toEqual([['cat']]);
  });
  it('L7 loop values and case patterns are data; every body is visited', () => {
    expect(commands('for x in touch /etc/x; do tee /etc/y; done')).toEqual([['tee', '/etc/y']]);
    expect(commands('case touch in /etc/x) tee /etc/y;; *) touch /etc/z;; esac')).toEqual([['tee', '/etc/y'], ['touch', '/etc/z']]);
    expect(commands('while false; do touch /etc/x; done; until true; do tee /etc/y; done')).toEqual([['false'], ['touch', '/etc/x'], ['true'], ['tee', '/etc/y']]);
    expect(commands('function f() { touch /etc/x; }; f')).toContainEqual(['touch', '/etc/x']);
  });
  it('L7 function/coprocess preambles open a body; argv braces stay operands', () => {
    expect(commands('function f { touch /etc/x; }')).toContainEqual(['touch', '/etc/x']);
    expect(commands('coproc worker { touch /etc/x; }')).toContainEqual(['touch', '/etc/x']);
    expect(commands('touch } /etc/x')).toEqual([['touch', '}', '/etc/x']]);
  });
  it('L7 arithmetic/test data only executes substitutions', () => {
    expect(commands('(( a = $(touch /etc/x) )); [[ $(tee /etc/y) ]]')).toEqual([['touch', '/etc/x'], ['tee', '/etc/y']]);
  });
  it.each(['>', '>>', '>|', '&>', '&>>', '<>', '2>', '12>>', '{out}>', '2>&'])('L8 write redirect %s', op => {
    const r = segments(`echo x ${op} /etc/x`).segments[0]!.redirects[0]!;
    expect(r.write).toBe(true); expect(r.target?.text).toBe('/etc/x');
  });
  it.each(['<', '<&', '<<<', '2>&1', '2>&-'])('L8 read/fd redirect %s', op => {
    expect(segments(`cat ${op} ./x`).segments[0]!.redirects[0]!.write).toBe(false);
  });
  it.each(['{1..513}', '${!x}', "$'a\\0b'"])('L9 word failure %s is local', raw => {
    const s = segments(`touch ${raw} /etc/x; tee /etc/y`).segments;
    expect(s[0]!.words[1]!.origin).toBe('unknown');
    expect(s[0]!.words[2]!.text).toBe('/etc/x');
    expect(s[1]!.words.map(w => w.text)).toEqual(['tee', '/etc/y']);
  });
  it('L9 expansion failure in a loop header never skips its body', () => {
    for (const range of ['{1..513}', '{1..32}{1..32}']) {
      expect(commands(`for x in ${range}; do touch /etc/x; done`)).toContainEqual(['touch', '/etc/x']);
    }
  });
  it('L9 malformed text preserves earlier segments and records truncation', () => {
    const s = segments("touch /etc/x; echo 'unfinished");
    expect(s.truncated).toBe(true); expect(s.segments[0]!.words[1]!.text).toBe('/etc/x');
    expect(s.segments[1]!.words[1]!.origin).toBe('unknown');
    // MAIN r2 H3 replaces whole-source rejection with one local Unknown.
    const oversized=segments('x'.repeat(MAX_TEXT_CHARS + 1)+'; touch /etc/x');
    expect(oversized.segments[0]!.words[0]!.origin).toBe('unknown');
    expect(oversized.segments.some(s=>s.words[0]?.text==='touch')).toBe(true);
  });
  it('L10 literal alternatives, tilde, variables, glob and concatenation', () => {
    const s = segments('touch {a,/etc/x} ~user/x "$x" *.x pre{a,b}post').segments[0]!;
    expect(s.words[1]!.alternatives).toEqual(['a', '/etc/x']);
    expect(s.words[2]!.text).toBe('~user/x');
    expect(s.words[3]!.origin).toBe('expansion');
    expect(s.words[4]!.origin).toBe('expansion');
    expect(s.words[5]!.alternatives).toEqual(['preapost', 'prebpost']);
  });
  it('L11 PowerShell quoting, escapes, invocation, scripts and redirects', () => {
    const s = segments('& Set-Content -Path "C:\\x" -Value \'it\'\'s\'; & { touch /etc/x }; echo a`;b *> ./out', { dialect: 'pwsh' });
    expect(s.segments[0]!.words.map(w => w.text)).toEqual(['Set-Content', '-Path', 'C:\\x', '-Value', "it's"]);
    expect(s.segments.some(s => s.depth === 1 && s.words[0]?.text === 'touch')).toBe(true);
    expect(s.segments.some(s => s.words.some(w => w.text === 'a;b'))).toBe(true);
    expect(s.segments.flatMap(s => s.redirects).some(r => r.write && r.fd === '*')).toBe(true);
  });
  // MAIN r2 H3 replaces r1 L12: no count cap, excess depth is flat.
  it('H3 streaming depth and segment count retain every executable span; groups remain distinct', () => {
    const flat=segments('echo $(echo $(tee /etc/x))', { maxDepth: 1 });
    expect(flat.truncated).toBe(false);
    expect(flat.segments.some(s=>s.words[0]?.text==='tee')).toBe(true);
    expect(segments('echo x;'.repeat(12)).segments).toHaveLength(13);
    const s = segments('echo x; (cd /etc; touch x); touch y').segments;
    expect(s.find(s => s.words[0]?.text === 'cd')?.group).not.toBe(0);
    expect(s.find(s => s.words[0]?.text === 'touch' && s.words[1]?.text === 'y')?.group).toBe(0);
  });
});

// Source-derived simple-command corpus. Structural constructs have explicit
// tests above; this comparison checks every lexical word/redirect/separator in
// each readable non-structural row, including the lexer/parser fixture strings.
const corpus: string[] = segmentDesignRows.map(row => row.command);
for (const file of ['lex.test.ts', 'parse.test.ts']) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => { if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) corpus.push(node.text); ts.forEachChild(node, visit); };
  visit(source);
}
it('SEG-PARITY lexical values and operators on readable fixture rows', () => {
  let compared = 0;
  for (const text of corpus) {
    let tokens; try { tokens = lex(text); } catch { continue; }
    if (tokens.some(t => t.kind === 'op' && t.op === '((') || /\b(?:for|select|case|esac)\b|\[\[|\(\(/.test(text)) continue;
    const actual = segments(text).segments;
    // The legacy lexer makes every bare brace an operator, including argv.
    // L7 keeps argv braces literal. Normalize that declared grammar difference;
    // direct L7 tests independently pin function bodies and brace operands.
    const braces = actual.filter(s => s.depth === 0).flatMap(s => [
      ...s.reserved.filter(w => w === '{' || w === '}').map(op => ({ op, literal: false })),
      ...[...s.assignments, ...s.words, ...s.redirects.flatMap(r => r.target ? [r.target] : [])].sort((a,b) => a.start - b.start).filter(w => w.raw === '{' || w.raw === '}').map(w => ({ op: w.raw, literal: true })),
    ]);
    let brace = 0;
    const reference = tokens.map(t => {
      if (t.kind !== 'op' || t.op !== '{' && t.op !== '}') return t;
      const item = braces[brace++];
      expect.soft(item?.op, text).toBe(t.op);
      return item?.literal ? { kind: 'word' as const, word: { parts: [{ kind: 'lit' as const, text: t.op, quote: 'none' as const }] } } : t;
    });
    expect.soft(brace, text).toBe(braces.length);
    const expectedWords = reference.filter(t => t.kind === 'word').map(t => renderWord(t.word));
    const actualWords = actual.filter(s => s.depth === 0).flatMap(s => [...s.reserved.filter(word => word !== '{' && word !== '}'), ...[...s.assignments, ...s.words, ...s.redirects.flatMap(r => r.target ? [r.target] : [])].sort((a,b) => a.start - b.start).map(w => w.text ?? renderWord(lexWordText(w.raw)))]);
    expect.soft(actualWords, text).toEqual(expectedWords);
    const expectedOps = reference.flatMap(t => t.kind === 'op' ? (t.op === '))' ? [')', ')'] : [t.op]) : t.kind === 'newline' ? ['\n'] : []);
    const actualOps = actual.filter(s => s.depth === 0).flatMap(s => [...s.reserved.filter(word => word === '{' || word === '}'), ...s.redirects.map(r => r.op), ...(s.sep === 'eof' ? [] : [s.sep])]);
    expect.soft(actualOps, text).toEqual(expectedOps);
    expect.soft(actual.filter(s => s.depth === 0).flatMap(s => s.redirects.flatMap(r => r.heredoc ? [r.heredoc.body] : [])), text).toEqual(tokens.flatMap(t => t.kind === 'op' && t.heredoc ? [t.heredoc.strip ? t.heredoc.body.replace(/^\t+/gm, '') : t.heredoc.body] : []));
    compared++;
  }
  expect(compared).toBeGreaterThan(100);
});

it('keeps an escaped-dollar parenthesized string out of executable segments', () => {
  const result = segments(String.raw`echo \$(rm -rf ~); tar -xf ./a -C /etc`);
  expect(result.segments.some(segment => segment.words[0]?.text === 'rm')).toBe(false);
  expect(result.segments.some(segment => segment.words[0]?.text === 'tar')).toBe(true);
});
it('labels sibling execution bodies with distinct scopes and raw source', () => {
  const result = segments('echo "$(cd /etc)" "$(tar -xf /tmp/a)"');
  const children = result.scopes!.filter(scope => scope.parent === 0);
  expect(children.map(scope => scope.source)).toEqual(['cd /etc', 'tar -xf /tmp/a']);
  expect(new Set(children.map(scope => scope.id)).size).toBe(2);
  expect(result.segments.filter(segment => segment.depth === 1).map(segment => segment.scope)).toEqual(children.map(scope => scope.id));
});
