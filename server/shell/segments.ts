// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lexWordText, isPlain, renderWord, MAX_TEXT_CHARS } from './lex.ts';

export type WordOrigin = 'plain' | 'expansion' | 'unknown';
export interface SegWord {
  raw: string; text: string | undefined; quoted: boolean; origin: WordOrigin;
  /** find substitutes this argv word; keep raw source without treating {} as a filename. */
  placeholder?:true;
  alternatives?: string[]; start: number; end: number;
}
export type SepOp = ';' | '&' | '&&' | '||' | '|' | '|&' | '\n' | '(' | ')' | ';;' | ';&' | ';;&' | 'eof';
export interface SegRedirect {
  op: string; fd?: number | string; target?: SegWord; write: boolean;
  heredoc?: { delimiter: string; quoted: boolean; body: string; bodyStart: number };
}
export interface Segment {
  reserved: string[]; assignments: SegWord[]; words: SegWord[]; redirects: SegRedirect[];
  sep: SepOp; depth: number;
  via?: 'subst' | 'backtick' | 'procsub' | 'heredoc-code' | 'heredoc-subst' | 'shell-c' | 'eval' | 'env-S' | 'find-exec' | 'program' | 'trap' | 'su-c';
  group: number;
  /** Execution body identity; sibling substitutions do not share cwd. */
  scope?: number; parentScope?: number; unknownBindings?:string[];
}
export interface SegmentResult { segments: Segment[]; truncated: boolean; scopes?: Array<{ id: number; parent?: number; source: string; depth: number; via?: Segment['via'] }> }
export interface SegmentOptions {
  dialect?: 'posix' | 'pwsh'; maxDepth?: number;
  /** Wrapper identity is supplied by the shared role table, without a lexer
   * dependency on the command grammar. Direct shells need no callback. */
  command?: (words: ReadonlyArray<string | undefined>) => { program: string; stdinCode?: boolean };
  onScope?: (scope: SegmentScope) => void;
  onScopeEnd?: (scope: SegmentScope) => void;
}
const OPS = [';;&', ';;', ';&', '&&', '&>>', '&>', '||', '|&', '<<<', '<<-', '<<', '>>', '>|', '>&', '<&', '<>', ';', '&', '|', '(', ')', '<', '>'];
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish']);
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'function']);

/** Source operators retain their identity. Word values always come from the
 * canonical lexer; a failure belongs to that word alone. No shell is executed. */
export interface SegmentScope { id:number; parent?:number; source:string; depth:number; via?:Segment['via'] }
/** Production consumes one segment at a time. Whole-source and segment-count
 * presentation limits never apply to executable inspection. */
export function forEachSegment(text: string, visit:(segment:Segment)=>void, opts:SegmentOptions={}): {truncated:boolean} {
  const result={truncated:false};
  const maxDepth = Math.max(0, Math.min(8, opts.maxDepth ?? 8));
  let nextScope = 0;
  let nextGroup = 0;
  const pwsh = opts.dialect === 'pwsh';
  const escape = pwsh ? '`' : '\\';
  const run = (source: string, depth: number, via?: Segment['via'], inheritedGroup = 0, parentScope?: number, flat = false) => {
    const scope = nextScope++;
    const scopeInfo={id:scope,parent:parentScope,source,depth,via};
    opts.onScope?.(scopeInfo);
    let i = 0;
    const flatQuotes:Record<string,number>={};
    let group = inheritedGroup;
    const groups: number[] = [];
    let words: SegWord[] = [], assignments: SegWord[] = [], reserved: string[] = [], redirects: SegRedirect[] = [];
    let nested: Array<{ text: string; via: NonNullable<Segment['via']> }> = [];
    let header = false, definition = false, loopVariable:string|undefined;
    let casePhase: 'subject' | 'in' | 'pattern' | undefined;
    const cases: number[] = [];
    let pending: Array<{ redirect: SegRedirect; segment?: Segment }> = [];
    const inner = (body: string, kind: NonNullable<Segment['via']>) => {
      run(body, Math.min(maxDepth, depth + 1), kind, group, scope, depth >= maxDepth);
    };
    const shell = (segment: Segment): boolean => {
      const values = segment.words.map(w => w.text);
      const role = opts.command?.(values);
      if(role?.stdinCode !== undefined)return role.stdinCode;
      const program = role?.program ?? (values[0] ?? '').replace(/^.*[\\/]/, '').toLowerCase();
      return SHELLS.has(program) && (values.length===1 || values[1]==='-s' || values[1]==='/dev/stdin')
        || (program === 'source' || program === '.') && values[1] === '/dev/stdin';
    };
    const deliver = (segment:Segment, substitutions:typeof nested) => {
      visit(segment);
      for(const item of substitutions)inner(item.text,item.via);
      // Redirect source order matters: the final redirect to fd 0 supplies
      // stdin. Other descriptors and overwritten heredocs remain data.
      const streams=new Map<number|string,SegRedirect>();
      for(const redirect of segment.redirects){
        const descriptor=redirect.fd??(redirect.op.startsWith('<')?0:1);
        if(['<&','>&'].includes(redirect.op)&&/^(?:\d+|-)$/.test(redirect.target?.text??'')){
          const from=streams.get(Number(redirect.target?.text));
          if(from)streams.set(descriptor,from);else streams.delete(descriptor);
        }else if(['<','<>','<<','<<-','<<<'].includes(redirect.op))streams.set(descriptor,redirect);
      }
      const stdin=streams.get(0);
      for(const redirect of segment.redirects){
        if(redirect===stdin && shell(segment)){
          if(redirect.heredoc)inner(redirect.heredoc.body,'heredoc-code');
          else if(redirect.op==='<<<' && redirect.target?.text!==undefined)inner(redirect.target.text,'heredoc-code');
        }
        // Expansion of every unquoted heredoc happens even when stdin was
        // redirected again, or when the descriptor is not fd 0.
        if(redirect.heredoc && !redirect.heredoc.quoted)for(const sub of substitutionsIn(redirect.heredoc.body))inner(sub.text,'heredoc-subst');
      }
    };
    const deferred:Array<{segment:Segment;substitutions:typeof nested}>=[];
    const flush = (sep: SepOp) => {
      const segment: Segment = { reserved, assignments, words, redirects, sep, depth, ...(via ? { via } : {}), group, scope, parentScope, ...(loopVariable?{unknownBindings:[loopVariable]}:{}) };
      for (const p of pending) if (!p.segment && redirects.includes(p.redirect)) p.segment = segment;
      if(pending.length)deferred.push({segment,substitutions:nested});
      else deliver(segment,nested);
      words = []; assignments = []; reserved = []; redirects = []; nested = []; header = false; definition = false; loopVariable=undefined;
    };
    /** Balanced source scanner, independent of expansion success. */
    const balanced = (open: number, close: string): { end: number; body: string; ok: boolean } => {
      const start = open + 1;
      let at = start, level = 1, quote = '';
      let caseCount = 0;
      while (at < source.length) {
        const c = source[at]!;
        if (c === escape && quote !== "'") { at += 2; continue; }
        if (quote) {
          if (c === quote) { if (pwsh && quote === "'" && source[at + 1] === "'") { at += 2; continue; } quote = ''; }
          else if (quote === '"' && c === '$' && source[at + 1] === '(') { at = balanced(at + 1, ')').end; continue; }
          at++; continue;
        }
        if (c === "'" || c === '"' || !pwsh && c === '`') { quote = c; at++; continue; }
        if (c === '#' && (at === start || /[\s;|&]/.test(source[at - 1]!))) { while (at < source.length && source[at] !== '\n') at++; continue; }
        if (close === ')' && /[A-Za-z]/.test(c) && (at === start || /[\s;|&]/.test(source[at - 1]!))) {
          const word = /^[A-Za-z]+/.exec(source.slice(at))?.[0];
          if (word === 'case') caseCount++;
          if (word === 'esac') caseCount = Math.max(0, caseCount - 1);
          if (word) { at += word.length; continue; }
        }
        if (c === source[open]) level++;
        if (c === close) {
          if (close === ')' && level === 1 && caseCount > 0) { at++; continue; }
          if (--level === 0) return { end: at + 1, body: source.slice(start, at), ok: true };
        }
        at++;
      }
      return { end: source.length, body: source.slice(start), ok: false };
    };
    const word = (): SegWord => {
      const start = i;
      let quote = '', quoted = false, ok = true;
      const substitutions: typeof nested = [];
      while (i < source.length) {
        const c = source[i]!;
        if (c === escape && quote !== "'") {
          quoted = true;
          // An escaped dollar does not open executable substitution code.
          // Preserve the existing malformed-input data treatment as one word.
          if (!quote && source[i + 1] === '$' && source[i + 2] === '(') {
            const b = balanced(i + 2, ')'); ok &&= b.ok; i = b.end; continue;
          }
          i += Math.min(2, source.length - i); continue;
        }
        if (quote === "'") {
          if (c === "'") { if (pwsh && source[i + 1] === "'") { i += 2; continue; } quote = ''; }
          i++; continue;
        }
        if (c === '"') { quoted = true; quote = quote ? '' : '"'; i++; continue; }
        if (!quote && c === "'") { quoted = true; quote = "'"; i++; continue; }
        if (c === '$' && source[i + 1] === '(' || !quote && (c === '<' || c === '>') && source[i + 1] === '(') {
          if(flat){if(quote)flatQuotes[quote]=(flatQuotes[quote]??0)+1;break;}
          const arithmetic = c === '$' && source[i + 2] === '(';
          const b = balanced(i + 1, ')');
          if (!arithmetic) substitutions.push({ text: b.body, via: c === '$' ? 'subst' : 'procsub' });
          else {
            // Arithmetic is data; only its nested substitutions execute.
            const body = b.body.slice(1, -1);
            substitutions.push(...substitutionsIn(body));
          }
          ok &&= b.ok; i = b.end; continue;
        }
        if (c === '$' && source[i + 1] === '{' || pwsh && !quote && c === '{') {
          const b = balanced(c === '$' ? i + 1 : i, '}');
          if (pwsh && c === '{') substitutions.push({ text: b.body, via: 'subst' });
          else substitutions.push(...substitutionsIn(b.body));
          ok &&= b.ok; i = b.end; continue;
        }
        if (!pwsh && c === '`') {
          quoted = true;
          const from = ++i;
          while (i < source.length && source[i] !== '`') { if (source[i] === '\\') i++; i++; }
          substitutions.push({ text: source.slice(from, i), via: 'backtick' });
          if (i === source.length) ok = false; else i++;
          continue;
        }
        if (!quote && /[ \t\n;&|()<>]/.test(c)) break;
        i++;
      }
      const raw = source.slice(start, i);
      const value: SegWord = { raw, text: undefined, quoted, origin: 'unknown', start, end: i };
      if (quote || !ok) result.truncated = true;
      else if(raw.length > MAX_TEXT_CHARS) { /* per-word Unknown; continue after it */ }
      else try {
        if ((raw === '{' || raw === '}') && !quoted) { value.origin = 'plain'; value.text = raw; }
        else if (pwsh) {
          // POSIX lex is still the single word-value reader after translating
          // only PowerShell's quote/escape spelling.
          let translated = '', q = '';
          for (let at = 0; at < raw.length; at++) {
            const c = raw[at]!;
            if (c === '`' && q !== "'") { const next = raw[++at]; if (next !== undefined && next !== '\n') translated += '\\' + next; continue; }
            if (c === "'" && q === "'" && raw[at + 1] === "'") { translated += "'\\''"; at++; continue; }
            if (c === "'" || c === '"') q = q === c ? '' : q || c;
            translated += c;
          }
          const parsed = lexWordText(translated);
          value.origin = isPlain(parsed) ? 'plain' : 'expansion';
          if (value.origin === 'plain') value.text = renderWord(parsed);
        } else {
          const parsed = lexWordText(raw);
          value.origin = isPlain(parsed) ? 'plain' : 'expansion';
          if (value.origin === 'plain') value.text = renderWord(parsed);
          else {
            let alts = [''];
            for (const part of parsed.parts) {
              const values = part.kind === 'brace' && part.alts.every(isPlain) ? part.alts.map(renderWord) : part.kind === 'lit' ? [part.text] : part.kind === 'tilde' ? ['~' + part.user] : undefined;
              if (!values || alts.length * values.length > 64) { alts = []; break; }
              alts = alts.flatMap(prefix => values.map(suffix => prefix + suffix));
            }
            if (alts.length) value.alternatives = alts;
          }
        }
      } catch { /* M-SEG-UNKNOWN-DROP: preserve this unknown word and continue */ }
      if (substitutions.length && value.origin !== 'unknown') { value.origin = 'expansion'; value.text = undefined; }
      nested.push(...substitutions);
      return value;
    };
    const substitutionsIn = (body: string): typeof nested => {
      const saved = i;
      // Scan heredoc data only for executable substitutions, never as commands.
      const out: typeof nested = [];
      for (let at = 0; at < body.length;) {
        if (body[at] === '\\') { at += 2; continue; }
        if (body.startsWith('$(', at)) {
          let end = at + 2, n = 1, q = '';
          for (; end < body.length; end++) {
            const c = body[end]!;
            if (c === '\\' && q !== "'") { end++; continue; }
            if (q) { if (c === q) q = ''; continue; }
            if (c === "'" || c === '"') { q = c; continue; }
            if (c === '(') n++;
            if (c === ')' && --n === 0) break;
          }
          // Count ')' only; other characters do not affect nesting.
          out.push({ text: body.slice(at + 2, end), via: 'subst' }); at = end + 1;
        } else if (body[at] === '`') {
          const from = ++at;
          while (at < body.length && body[at] !== '`') { if (body[at] === '\\') at++; at++; }
          out.push({ text: body.slice(from, at), via: 'backtick' }); at++;
        } else at++;
      }
      i = saved;
      return out;
    };
    const drain = () => {
      for (const p of pending) {
        const hd = p.redirect.heredoc!;
        hd.bodyStart = i;
        const lines: string[] = [];
        while (i < source.length) {
          let line = '', last = false;
          for (;;) {
            const end = source.indexOf('\n', i);
            last = end < 0;
            const physical = source.slice(i, last ? source.length : end);
            i = last ? source.length : end + 1;
            const cooked = p.redirect.op === '<<-' ? physical.replace(/^\t+/, '') : physical;
            const trailing = /\\+$/.exec(physical)?.[0].length ?? 0;
            // Shell heredocs remove an unquoted backslash-newline before
            // delimiter matching and expansion, including split $(...) text.
            if (!hd.quoted && trailing % 2 === 1 && !last) {
              line += cooked.slice(0, -1);
              continue;
            }
            line += cooked;
            break;
          }
          if (line === hd.delimiter) break;
          lines.push(line + (last ? '' : '\n'));
        }
        hd.body = lines.join('');

      }
      pending = [];
      for(const item of deferred)deliver(item.segment,item.substitutions);
      deferred.length=0;
    };
    while (i < source.length) {
      const c = source[i]!;
      if(flat && (source.startsWith('$(',i)||source.startsWith('<(',i)||source.startsWith('>(',i))){i+=2;flush('(');continue;}
      if (c === ' ' || c === '\t' || c === escape && source[i + 1] === '\n') { i += c === escape ? 2 : 1; continue; }
      if (c === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
      if (c === '\n') { i++; flush('\n'); drain(); continue; }
      const fd = /^(\d+|\{[A-Za-z_]\w*\}|\*)(?=[<>])/.exec(source.slice(i));
      let descriptor: number | string | undefined;
      if (fd && source[i + fd[0].length + 1] !== '(') { descriptor = /^\d+$/.test(fd[0]) ? Number(fd[0]) : fd[0]; i += fd[0].length; }
      const op = OPS.find(op => source.startsWith(op, i));
      if (op && !(source[i] === '<' || source[i] === '>') || op && source[i + 1] !== '(') {
        i += op.length;
        if (op.includes('<') || op.includes('>')) {
          while (source[i] === ' ' || source[i] === '\t') i++;
          const target = i < source.length && source[i] !== '\n' ? word() : undefined;
          const redirect: SegRedirect = { op, ...(descriptor !== undefined ? { fd: descriptor } : {}), write: ['>', '>>', '>|', '&>', '&>>', '<>'].includes(op) || op === '>&' && target?.text !== undefined && !/^(?:\d+|-)$/.test(target.text) };
          if (op === '<<' || op === '<<-') {
            redirect.heredoc = { delimiter: target?.text ?? target?.raw ?? '', quoted: target?.quoted ?? false, body: '', bodyStart: i };
            pending.push({ redirect });
          } else redirect.target = target;
          redirects.push(redirect);
        } else if (op === '(' && casePhase === 'pattern') { /* an optional case-pattern opener, not a subshell */ }
        else if (op === '(' && source[i] === '(') {
          const b = balanced(i - 1, ')'); nested.push(...substitutionsIn(b.body)); i = b.end;
        } else if (op === '(') { groups.push(group); group = ++nextGroup; flush('('); }
        else if (op === ')' && casePhase === 'pattern') { casePhase = undefined; }
        else if (op === ')') {
          flush(')'); group = groups.pop() ?? inheritedGroup;
          const closingQuote=source[i];
          if(flat&&closingQuote&&(flatQuotes[closingQuote]??0)>0){flatQuotes[closingQuote]=(flatQuotes[closingQuote]??0)-1;i++;}
        }
        else if (pwsh && op === '&' && !words.length) { reserved.push('&'); }
        else { flush(op as SepOp); if ([';;', ';&', ';;&'].includes(op) && cases.length) casePhase = 'pattern'; }
        continue;
      }
      if (!pwsh && source.startsWith('[[', i)) {
        const end = source.indexOf(']]', i + 2);
        nested.push(...substitutionsIn(source.slice(i + 2, end < 0 ? source.length : end)));
        i = end < 0 ? source.length : end + 2; continue;
      }
      const w = word();
      if (w.start === w.end) { i++; result.truncated = true; continue; }
      const bare = !w.quoted ? w.text : undefined;
      if (casePhase === 'subject') { casePhase = 'in'; continue; }
      if (casePhase === 'in') { if (bare === 'in') casePhase = 'pattern'; continue; }
      if (casePhase === 'pattern') { if (bare === 'esac') { casePhase = undefined; cases.pop(); } continue; }
      if (!words.length && bare === 'case') { reserved.push('case'); cases.push(1); casePhase = 'subject'; continue; }
      if (!words.length && (bare === 'for' || bare === 'select')) { reserved.push(bare); header = true; continue; }
      if (header) {if(!loopVariable&&bare&&/^[A-Za-z_]\w*$/.test(bare))loopVariable=bare;continue;}
      if (!words.length && (bare === 'function' || bare === 'coproc')) { reserved.push(bare); definition = true; continue; }
      if (bare === '{' && definition) { flush('eof'); reserved.push('{'); continue; } // M-SEG-HEADER-BODY
      if (!words.length && bare && RESERVED.has(bare)) { reserved.push(bare); continue; }
      if (!words.length && /^[A-Za-z_]\w*=/.test(w.raw)) { assignments.push(w); continue; }
      words.push(w);
    }
    if (i < source.length) result.truncated = true;
    flush('eof');
    if (pending.length) drain();
    opts.onScopeEnd?.(scopeInfo);
  };
  run(text, 0);
  return result;
}

/** Array projection for tests and compatibility diagnostics only. */
export function segments(text:string,opts:SegmentOptions={}):SegmentResult {
 const rows:Segment[]=[],scopes:SegmentScope[]=[];
 const result=forEachSegment(text,segment=>rows.push(segment),{...opts,onScope:scope=>{scopes.push(scope);opts.onScope?.(scope);}});
 return {segments:rows,scopes,truncated:result.truncated};
}
