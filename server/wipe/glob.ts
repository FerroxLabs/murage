// SPDX-License-Identifier: AGPL-3.0-or-later
import { known, type Dialect, type Value } from './types.ts';

/** dir/pattern keep the pre-table operand adapter compatible until it imports this type. */
export interface GlobSpec {
 base: string;
 segments: string[];
 dialect: Dialect;
 dir: string;
 pattern: string;
}
export type GlobValue = Extract<Value,{k:'known'}> & { recursiveGlob?: boolean; globText?: string };
const escapeOf = (dialect: Dialect) => dialect === 'pwsh' ? '`' : dialect === 'sh' ? '\\' : '';
const regexLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function unescape(s: string, dialect: Dialect): string {
 const escape = escapeOf(dialect);
 let out = '';
 for (let i = 0; i < s.length; i++) out += s[i] === escape && i + 1 < s.length ? s[++i] : s[i];
 return out;
}
function hasWildcard(s: string, dialect: Dialect): boolean {
 const escape = escapeOf(dialect);
 for (let i = 0; i < s.length; i++) {
  if (s[i] === escape && i + 1 < s.length) { i++; continue; }
  if (s[i] === '*' || s[i] === '?' || s[i] === '[' && s.indexOf(']', i + 1) > i + 1) return true;
 }
 return false;
}

/** Compile a single path segment. Separators are walked by RootClassifier. */
export function globRegExp(pattern: string, dialect: Dialect, ignoreCase = false): RegExp {
 const escape = escapeOf(dialect);
 let source = '';
 for (let i = 0; i < pattern.length; i++) {
  const ch = pattern[i]!;
  if (ch === escape && i + 1 < pattern.length) { source += regexLiteral(pattern[++i]!); continue; }
  if (ch === '*') { source += '[^/]*'; while (pattern[i + 1] === '*') i++; continue; }
  if (ch === '?') { source += '[^/]'; continue; }
  if (ch === '[') {
   let end = i + 1;
   if (pattern[end] === '!' || pattern[end] === '^') end++;
   if (pattern[end] === ']') end++;
   for (; end < pattern.length; end++) {
    if (pattern[end] === escape && end + 1 < pattern.length) { end++; continue; }
    if (pattern[end] === ']') break;
   }
   if (end < pattern.length) {
    let body = pattern.slice(i + 1, end), negate = '';
    if (body[0] === '!' || body[0] === '^') { negate = '^'; body = body.slice(1); }
    let chars = '';
    for (let j = 0; j < body.length; j++) {
     const c = body[j]!;
     if (c === escape && j + 1 < body.length) chars += '\\' + body[++j];
     else chars += c === '\\' || c === ']' || c === '^' ? '\\' + c : c;
    }
    try { new RegExp('[' + negate + chars + ']'); source += '[' + negate + chars + ']'; i = end; continue; } catch { /* malformed ranges name literal brackets */ }
   }
  }
  source += regexLiteral(ch);
 }
 return new RegExp('^' + source + '$', ignoreCase ? 'i' : '');
}

/** Text is dequoted; PowerShell quoting alone does not make -Path literal. */
export function globValue(text: string, dialect: Dialect, literal = false): GlobValue {
 if(dialect!=='sh')text=text.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i,'\\\\').replace(/^[\\/]{2}[?.][\\/](?=[a-z]:[\\/])/i,'');
 if (literal) return known(text);
 const globText=text;
 if (dialect === 'cmd') text = text.replace(/(^|[\\/])\*\.\*(?=[\\/]*$)/, '$1*');
 if (!hasWildcard(text, dialect)) return {...known(unescape(text, dialect)),globText};
 const separator = dialect === 'sh' ? /\// : /[\\/]/;
 const trailing = separator.test(text.at(-1) ?? '');
 const parts = text.split(separator);
 while (parts.length > 1 && parts.at(-1) === '') parts.pop();
 let wholeDirGlob = false, recursiveGlob = parts.includes('**');
 if (parts.at(-1) === '*' || parts.at(-1) === '**') { wholeDirGlob = true; parts.pop(); }
 const first = parts.findIndex(part => hasWildcard(part, dialect));
 if (first < 0) {
  let dir = parts.join('/');
  if (!dir) dir = text.startsWith('/') || dialect !== 'sh' && text.startsWith('\\') ? '/' : '.';
  if (/^[a-z]:$/i.test(dir)) dir += /^[a-z]:[\\/]/i.test(text) ? '/' : '.';
  return { ...known(unescape(dir, dialect)), wholeDirGlob, dirsOnly: trailing, recursiveGlob,globText };
 }
 let base = parts.slice(0, first).join('/'), segments = parts.slice(first);
 // C:foo is relative to this drive's provider cwd, unlike C:\foo.
 const driveRelative = first === 0 ? /^([a-z]:)(.*)$/i.exec(segments[0]!) : null;
 if (driveRelative) { base = driveRelative[1]!+'.'; segments = [driveRelative[2]!, ...segments.slice(1)]; }
 else if (!base) base = text.startsWith('/') || dialect !== 'sh' && text.startsWith('\\') ? '/' : '.';
 else if (/^[a-z]:$/i.test(base)) base += '/';
 base = unescape(base, dialect);
 const glob: GlobSpec = { base, segments, dialect, dir: base, pattern: segments.join('/') };
 return { ...known(text), glob, wholeDirGlob, dirsOnly: trailing, recursiveGlob,globText };
}
