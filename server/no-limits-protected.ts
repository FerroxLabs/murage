// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// No limits protects writes, rather than every mention of a protected place.
import { protectedClass, type AlwaysAskHit } from './always-ask.ts';
import { SENSITIVE_PATHS } from '../shared/sensitive-paths.ts';
import { gateHit } from '../shared/gate-files.ts';
import { readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { ownerMarks, withoutDoubts } from './shell/marks.ts';
import { isPlain, renderWord, Unreadable } from './shell/lex.ts';
import { candidatesOf, canonPath, deviceReadPosition, homeSpelled, interpreterKey, isAnchored, newContext, normalizePath, outputOption, resolveFrom, UNKNOWN_MARK, walkScript, type Candidate, type SimpleCommand, type Visitor, type WalkContext } from './shell/walk.ts';
import { looksLikePowerShell, walkCmd, walkPwsh } from './shell/pwsh.ts';
import { archiveWrites } from './no-limits-archives.ts';
import { forEachOwnerSegment } from './no-limits-shell.ts';
import { segmentWordPaths } from './no-limits-word-paths.ts';
import { type SegWord } from './shell/segments.ts';
import { commandRoles, writeSlots } from './shell/roles.ts';
import { protectedCwdSuffix } from './no-limits-cwd-suffix.ts';
import type { AutoContext } from './auto-approve.ts';
import type { OwnerProtectedDecision } from './no-limits-taint.ts';
import { inspectOwnerOperation } from './no-limits-inspection.ts';
import { effectiveCwd } from './no-limits-fs.ts';
export { inspectNoLimits } from './no-limits-taint.ts';

/** Compatibility projection only; structured decisions remain the authority. */
export function protectedDecisionHit(decision:OwnerProtectedDecision|undefined):AlwaysAskHit|null {
  return decision ? {rule:'protected-path',classification:'deny',reason:'protected-path',what:'This writes a protected path.',protectedClass:decision.protectedClass as AlwaysAskHit['protectedClass'],program:decision.ruleId} : null;
}
function inspectProtectedText(text:string,context?:AutoContext,shell?:'pwsh') {
  const dialect=shell==='pwsh'?'pwsh':looksLikePowerShell(text)==='cmd'||/^\s*(?:mklink|fsutil)\b/i.test(text)?'cmd':'sh';
  const sessionReader=context?.sessionFile??context?.unseen?.sessionFile;
  const inspection=inspectOwnerOperation({kind:'exec',text,dialect,cwd:effectiveCwd(context),cwdInvalid:context?.commandCwdInvalid===true},{runtimePaths:context?.runtimePaths,sessionEdits:context?.readOnlyHooks?.sessionEdits??context?.unseen?.sessionEdits,sessionFile:sessionReader?path=>sessionReader(path)??'unavailable':undefined});
  return inspection;
}

export function structuredProtectedWrite(text:string,context?:AutoContext,shell?:'pwsh'):AlwaysAskHit|null {
  return protectedDecisionHit(inspectProtectedText(text,context,shell).decisions[0]);
}

/** Resolve only this write's components, including links made earlier in this call.
 * A missing leaf still inherits its resolved parent. Resolve before consuming `..`.
 * Link substitutions have a fixed bound; no directory or session enumeration. */
type PendingLink = { recorded: string; target: string };
class LinkResolutionLimit extends Error {}
function writePath(raw: string, ctx: WalkContext, context: AutoContext | undefined, followFinal = true, hops = 0, links: ReadonlyMap<string, PendingLink> = new Map()): string {
  const spelled = homeSpelled(raw).replace(/^~(?=\/|$)/, homedir());
  const joined = isAnchored(spelled) ? spelled : `${ctx.cwd ? homeSpelled(ctx.cwd).replace(/^~(?=\/|$)/, homedir()) + '/' : ''}${spelled}`;
  // Preserve the walker's ordinary stream aliases instead of following them into /proc.
  if (/^\/dev\/(?:stdin|stdout|stderr|fd\/\d+)$/.test(normalizePath(joined))) return normalizePath(joined);
  const drive = /^[a-z]:\//i.exec(joined)?.[0];
  let resolved = drive ?? (joined.startsWith('/') ? '/' : '');
  const parts = joined.slice(drive?.length ?? 0).split('/').filter(part => part && part !== '.');
  for (let i = 0; i < parts.length; i++) {
    const next = normalizePath(`${resolved}${resolved && !resolved.endsWith('/') ? '/' : ''}${parts[i]}`);
    if (!followFinal && i === parts.length - 1) return next;
    const recorded = ctx.links.get(next);
    const correction = links.get(next);
    const pending = correction && correction.recorded === recorded ? correction.target : recorded;
    if (pending !== undefined) {
      if (hops >= 40) throw new LinkResolutionLimit();
      return writePath([pending, ...parts.slice(i + 1)].join('/'), ctx, context, followFinal, hops + 1, links);
    }
    try { resolved = (context?.unseen?.fs?.realpath ?? realpathSync.native)(next).replaceAll('\\', '/'); }
    catch {
      // realpath cannot resolve a dangling leaf, but its target can still be protected.
      let link: string | undefined;
      try { link = readlinkSync(next); } catch { /* missing or ordinary component */ }
      if (link !== undefined) {
        if (hops >= 40) throw new LinkResolutionLimit();
        const parent = next.slice(0, next.lastIndexOf('/') + 1);
        const target = isAnchored(homeSpelled(link)) ? link : parent + link;
        return writePath([target, ...parts.slice(i + 1)].join('/'), ctx, context, followFinal, hops + 1, links);
      }
      resolved = next;
    }
  }
  return resolved;
}

/** One bounded read of this call's executable components. No transcript or historical file enumeration. */
export function noLimitsProtectedWrite(text: string, context?: AutoContext, shell?: 'pwsh', gates = false, realTargetsOnly = false): AlwaysAskHit | null {
  const inspection=inspectProtectedText(text,context,shell);
  const completedCode=new Set(inspection.codeBodies?.map(body=>body.text)??[]);
  const structured=protectedDecisionHit(inspection.decisions[0]);
  if(structured)return structured;
  let found: AlwaysAskHit | null = null;
  // Correct only links this call created and whose walker record still matches.
  // The legacy walker records source paths relative to cwd, rather than LINK.
  const pendingLinks = new Map<string, PendingLink>();
  const target = (raw: string, ctx: WalkContext, followFinal = true, checkLexical = false) => {
    const path = raw.replace(/^['"]|['"]$/g, '');
    let absolute: string;
    try { absolute = writePath(path, ctx, context, followFinal, 0, pendingLinks); }
    catch (error) {
      if (!(error instanceof LinkResolutionLimit)) throw error;
      // Bounded resolution must never erase a possible protected write.
      return found ??= { rule: 'protected-path', classification: 'deny', reason: 'protected-path', what: 'This writes a protected path.' };
    }
    // The approval seam uses this mode to retain new link-derived denies even
    // when the legacy reader returned no finding (for example a dangling link).
    const lexical = normalizePath(resolveFrom(ctx.cwd, path).replace(/^~(?=\/|$)/, homedir()));
    if (realTargetsOnly && !checkLexical && normalizePath(absolute) === lexical) return null;
    const protectedKind = ownerMarks(() => protectedClass(path) ?? protectedClass(absolute));
    const gate = gates ? gateHit([path, absolute, path+'/', absolute+'/']) ?? SENSITIVE_PATHS.find(row => row.re.test(path) || row.re.test(absolute) || row.re.test(path+'/') || row.re.test(absolute+'/'))?.re.source ?? null : null;
    if (protectedKind || gate) found ??= { rule: 'protected-path', classification: 'deny', reason: 'protected-path',
      what: 'This writes a protected path.', ...(protectedKind ? { protectedClass: protectedKind } : {}), ...(gate ? { program: gate } : {}) };
    return found;
  };
  const targets = (items: Candidate[], ctx: WalkContext) => {
    for (const item of items) target(item.kind === 'value' ? item.path.replaceAll(UNKNOWN_MARK, '') : item.path, ctx);
    return found;
  };
  // The lexer preserves code operands as single words. Only write APIs expose their path strings as write targets.
  const code = (body: string, ctx: WalkContext, python = false) => {
    if(completedCode.has(body))return;
    if (!/\b(?:write\w*|append\w*|truncate\w*|tofile|FileIO|unlink\w*|remove\w*|rmtree|rmSync|mkdir\w*|rename\w*|chmod\w*|chown\w*|syscall)\s*\(|\bopen\s*\([^\n]*["'][wax][b+]*["']/.test(body)) return;
    if (python) for (let depth = 0; depth < 8; depth++) {
      const joined = body.replace(/(["'])([A-Za-z0-9_./-]*)\1\s*\+\s*(["'])([A-Za-z0-9_./-]*)\3/g,
        (_match, quote: string, left: string, _rightQuote: string, right: string) => quote + left + right + quote);
      if (joined === body) break;
      body = joined;
    }
    for (const match of body.matchAll(/["'`]((?:\/|~\/|[A-Za-z]:[\\/])[^"'`\n]*)["'`]/g)) target(match[1]!, ctx);
  };
  // Early checks inspect command operands before the walker can stop at opaque
  // code. Only the normal command visit may change cwd or pending-link state.
  const command = (cmd: SimpleCommand, ctx: WalkContext, advance = false) => {
    const name = cmd.name.toLowerCase().replace(/\.exe$/, '');
    const args = cmd.args.map(renderWord);
    const symbolic = name === 'ln' && args.some(arg => /^-[a-z]*s/.test(arg) || arg === '--symbolic');
    if (advance && name === 'cd' && args[0]) ctx.cwd = resolveFrom(ctx.cwd, args[0]);
    const joined = args.join(' ');
    const archive = archiveWrites(name, args, cmd.operands, ctx.cwd);
    if (archive !== undefined) {
      for (const path of archive) target(path, ctx, true, true);
      return found;
    }
    // DIFF-WALK: readable commands use the same write roles as recovery.
    // Link placement keeps its dedicated resolver; archive roots are projected
    // by the shared archive visitor at integration.
    const roles = commandRoles([name, ...cmd.args.map(word => isPlain(word) ? renderWord(word) : undefined)]);
    if (name !== 'ln' && !roles.archive) for (const slot of writeSlots(roles)) {
      if (slot.value !== undefined) target(slot.value, ctx);
      else if (slot.arg > 0) for (const item of cmd.operands[slot.arg - 1] ?? []) target(item.path.replaceAll(UNKNOWN_MARK, '').slice(slot.offset), ctx);
    }

    for (let i = 0; i < args.length; i++) {
      const output = outputOption(args, i, name);
      if (output && !symbolic && !/^(?:echo|printf|git)$/.test(name)) target(output.file, ctx);
    }
    if (/^(?:docker|podman|nerdctl|systemd-nspawn)$/.test(name)) {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (/^--bind-ro(?:=|$)/.test(arg)) { if (!arg.includes('=')) i++; continue; }
        const match = /^(?:--(?:volume|mount|bind)=|-[a-z]*v=?)(.*)$/.exec(arg);
        const value = match ? match[1] || args[++i] : /^(?:--volume|--mount|--bind)$/.test(arg) ? args[++i] : undefined;
        if (!value || /:ro(?:,|$)|(?:^|,)readonly(?:=true)?(?:,|$)/.test(value)) continue;
        target(/(?:^|,)(?:source|src)=([^,]+)/.exec(value)?.[1] ?? value.split(':')[0]!, ctx);
      }
    }
    const writer = /^(?:cp|mv|install|ln|tee|touch|mkdir|rmdir|truncate|chmod|chown|rm|srm|shred|unlink|dd|tar|unzip|zip|rsync|rclone|robocopy|aws|gsutil|azcopy|mc|remove-item|ri|set-content|add-content|out-file|copy-item|move-item|new-item)$/.test(name)
      || /(?:wipe|nuke|cleanse|zap)/i.test(name) || args.includes('--wipe') || (name === 'find' && args.includes('-delete'));
    if (writer) {
      const sourceEnd = /^(?:rclone|robocopy|aws|gsutil|azcopy|mc)$/.test(name) ? args.filter(arg => !arg.startsWith('-')).slice(0, -1) : [];
      if (symbolic) {
        const operands: string[] = [];
        let directory: string | undefined;
        let noDirectory = false;
        let noDereference = false;
        for (let i = 0; i < args.length; i++) {
          const arg = args[i]!;
          if (arg === '--') { operands.push(...args.slice(i + 1)); break; }
          if (arg === '--target-directory') { directory = args[++i]; continue; }
          if (arg.startsWith('--target-directory=')) { directory = arg.slice('--target-directory='.length); continue; }
          if (arg === '--no-target-directory') noDirectory = true;
          if (arg === '--no-dereference') noDereference = true;
          if (arg === '--suffix') { i++; continue; }
          if (arg.startsWith('--')) continue;
          if (arg.startsWith('-')) {
            for (let k = 1; k < arg.length; k++) {
              const option = arg[k]!;
              if (option === 'T') noDirectory = true;
              if (option === 'n') noDereference = true;
              if (option === 't' || option === 'S') {
                const value = arg.slice(k + 1) || args[++i];
                if (option === 't') directory = value;
                break;
              }
            }
            continue;
          }
          operands.push(arg);
        }
        const destination = directory ?? (operands.length > 1 ? operands.pop() : undefined);
        if (destination !== undefined) {
          let intoDirectory = directory !== undefined || destination.endsWith('/') || operands.length > 1;
          if (!noDirectory && !noDereference && !intoDirectory) {
            let resolved: string;
            try { resolved = writePath(destination, ctx, context, true, 0, pendingLinks); }
            catch (error) {
              if (!(error instanceof LinkResolutionLimit)) throw error;
              return target(destination, ctx);
            }
            // Pending directory links need no filesystem entry to prove their type.
            try { intoDirectory = (context?.unseen?.fs?.stat ?? statSync)(resolved).isDirectory(); } catch { /* absent destination */ }
          }
          for (const source of operands) {
            const link = intoDirectory && !noDirectory ? `${destination.replace(/\/+$/, '')}/${source.replace(/^.*\//, '')}` : destination;
            target(link, ctx, false);
            if (advance) {
              const key = writePath(link, ctx, context, false, 0, pendingLinks);
              const parent = key.slice(0, key.lastIndexOf('/') + 1);
              pendingLinks.set(key, { recorded: canonPath(source, ctx, 'read').path, target: isAnchored(homeSpelled(source)) ? source : parent + source });
            }
          }
        }
      }
      for (let i = 0; i < cmd.operands.length; i++) {
        if (deviceReadPosition(name, args, i)) continue;
        // Symbolic-link text is not written. Only the link's destination is.
        if (symbolic) continue;
        if (name === 'robocopy' ? i === 0 : sourceEnd.includes(args[i]!)) continue;
        if (name === 'rsync' && args.some(arg => arg.startsWith('--files-from')) && i !== args.length - 1) continue;
        targets(cmd.operands[i]!, ctx);
      }
    }
    if (/^(?:g?sed|g?awk|nawk|mawk)$/.test(name)) {
      if (/\bprint\s*>/.test(joined)) for (const arg of args) {
        const assigned = /^[A-Za-z_][\w]*=(.*)$/.exec(arg);
        if (assigned) target(assigned[1]!, ctx);
      }
      for (const arg of args) {
        const writes = name.endsWith('sed') ? arg.matchAll(/(?:^|[;{}\n!]|-[A-Za-z]*e|=|[\/|#,0-9$])\s*[wW]\s*([^\s;}'"]+)/g) : arg.matchAll(/>>?\s*["']([^"']+)["']/g);
        for (const match of writes) target(match[1]!, ctx);
      }
      if (name.endsWith('sed') && args.some(arg => /^-\w*i|^--in-place/.test(arg))) for (const items of cmd.operands) targets(items, ctx);
    }
    const inPlace = name === 'ruby' && args.some(arg => /^-[anpl]*i/.test(arg))
      || /^(?:g?awk)$/.test(name) && args.some((arg, i) => arg === '-iinplace' || arg === '--include=inplace' || /^(?:-i|--include)$/.test(arg) && args[i + 1] === 'inplace');
    // In-place editing writes the input files; inline code and include paths are option values.
    if (inPlace) for (let i = 0; i < args.length; i++) {
      if (/^(?:-e|-r|-I|-C|-F|-E|--include)$/.test(args[i]!) || /^(?:g?awk)$/.test(name) && args[i] === '-i') { i++; continue; }
      if (!args[i]!.startsWith('-')) targets(cmd.operands[i]!, ctx);
    }
    if (name === 'find') for (let i = 0; i < args.length; i++) if (/^-(?:fprint0?|fprintf|fls)$/.test(args[i]!)) target(args[++i] ?? '', ctx);
    if (name === 'sort') for (let i = 0; i < args.length; i++) if (/^-T/.test(args[i]!)) target(args[i]!.slice(2) || args[++i] || '', ctx);
    if (name === 'make' && args.includes('install')) for (let i = 0; i < args.length; i++) if (/^-C/.test(args[i]!)) target(args[i]!.slice(2) || args[++i] || '', ctx);
    if (gates && name === 'reg' && /^(?:add|delete|import)\b/i.test(joined) && gateHit([joined])) target(joined, ctx);
    if (interpreterKey(name) !== undefined) for (const arg of args) code(arg, ctx, interpreterKey(name) === 'python');
    return found;
  };
  const visitor: Visitor<AlwaysAskHit> = {
    continueOnUnreadable: true,
    forkBomb: () => ({ rule: 'fork-bomb', what: 'fork bomb' }),
    redirect: (redirect, _word, items, ctx) => /^(?:\d*|&)>>?|^<>/.test(redirect.op) ? targets(items, ctx) : null,
    pwshRedirect: (_word, items, ctx) => targets(items, ctx),
    unseenScript: (path, ctx) => {
      // Consult only the exact session file this command executes.
      if ((context?.readOnlyHooks?.sessionEdits ?? context?.unseen?.sessionEdits)?.has(path)) {
        const file = (context?.sessionFile ?? context?.unseen?.sessionFile)?.(path);
        if (file && file !== 'unavailable') code(file.text, ctx, /\.py$/i.test(path));
      }
      return true;
    },
    wrapperArgs: (words, ctx) => {
      // Wrapper cwd and input-list options are reads. A lock or output file is written.
      if (/\bflock\s|\btime\s+-o\s/.test(text)) for (const word of words) targets(candidatesOf(word, ctx), ctx);
      return found;
    },
    command: (cmd, ctx) => command(cmd, ctx, true),
    // Called before interpreter code or scripts can stop the walk on an unreadable finding.
    protectedCommand: (cmd, ctx) => command(cmd, ctx),
  };
  const ctx = newContext(effectiveCwd(context), context?.runtimePaths);
  ctx.unknownUnreadableWords = true;
  const dialect = shell ?? looksLikePowerShell(text);

  let walkCompleted=false;
  const inspectSegments=()=>{
      const originalCwd = effectiveCwd(context);
      forEachOwnerSegment(text, originalCwd, ({segment:row,roles,cwds:before,selected:local,context:bound})=>{
        const paths = (word: SegWord | undefined, cwd: string | undefined) => segmentWordPaths(word, {...bound,cwd});
        const check = (value:string|undefined,cwd:string|undefined)=>{
          if(value===undefined)return;
          if(cwd===undefined && protectedCwdSuffix(value,dialect==='pwsh'?'pwsh':'posix'))found??={rule:'protected-path',classification:'deny',reason:'protected-path',what:'This writes a protected path.'};
          target(value,{...ctx,cwd},roles.program!=='ln');
        };
          for (const cwd of before) for (const redirect of row.redirects) if (redirect.write) {
            for (const path of paths(redirect.target, cwd)) check(path, cwd); // M-FB-REDIRECT
          }
          for (const cwd of local) {
            if (roles.archive) {
              const archive = roles.archive;
              // archive slots are relative to args, while role slots retain
              // wrapper positions. Match the shared slot's source location.
              const slotValues = (index: number) => {
                const slot = archive.slots[index]!;
                if (slot.value !== undefined) return [slot.value];
                const projected = roles.slots[roles.slots.length - archive.slots.length + index];
                return paths(projected ? row.words[projected.arg] : undefined, cwd).map(path => path.slice(slot.offset));
              };
              const roots = new Map<number, string[]>([[-1, [cwd ?? '$PWD']]]);
              const join = (bases: string[], leaves: string[]) => bases.flatMap(base => leaves.map(leaf => isAnchored(homeSpelled(leaf)) ? leaf : `${base}/${leaf}`));
              const root = (index: number): string[] => {
                if (roots.has(index)) return roots.get(index)!;
                const chain: number[] = [];
                let at = index;
                while (!roots.has(at)) { chain.push(at); at = archive.tool === 'tar' ? archive.slots[at]!.root ?? -1 : -1; }
                for (let i = chain.length - 1; i >= 0; i--) {
                  const next = chain[i]!;
                  const slot = archive.slots[next]!;
                  roots.set(next, join(roots.get(archive.tool === 'tar' ? slot.root ?? -1 : -1)!, slotValues(next)));
                }
                return roots.get(index)!;
              };
              if (archive.implicitCwdRoot && !archive.stdoutOnly) check(cwd ?? '$PWD', cwd);
              for (const [index, slot] of archive.slots.entries()) if (slot.role === 'write') {
                const outputs = slot.detail === 'extract-root' ? root(index) : slot.detail === 'member-out' ? join(root(slot.root ?? -1), slotValues(index)) : slotValues(index);
                for (const path of outputs) if (slot.detail !== 'archive-out' || path !== '-') check(path, cwd);
              }
            } else for (const slot of writeSlots(roles)) {
              // A completed walk already applied ln final-component semantics.
              // Recovery does not reinterpret its namespace effects.
              if(walkCompleted&&roles.program==='ln')continue;
              if (slot.value !== undefined) check(slot.value, cwd);
              else for (const path of paths(row.words[slot.arg], cwd)) check(path.slice(slot.offset), cwd);
            }
            // Preserve the existing script-output reader on script slots only.
            if (/^(?:g?sed|g?awk|nawk|mawk)$/.test(roles.program)) for (const slot of roles.slots) if (slot.role === 'script' && slot.value !== undefined) {
              const matches = roles.program.endsWith('sed') ? slot.value.matchAll(/(?:^|[;{}\n!]|[\/|#,0-9$])\s*[wW]\s*([^\s;}'"]+)/g) : slot.value.matchAll(/>>?\s*["']([^"']+)["']/g);
              for (const match of matches) check(match[1], cwd);
            }
          }
      }, dialect==='pwsh'?'pwsh':'posix',context?.unseen?.fs?.realpath ?? realpathSync.native);
  };
  try {
    ownerMarks(() => withoutDoubts(() => {
      if (dialect === 'pwsh') {
        ctx.windowsBash = [];
        walkPwsh(text, ctx, visitor);
      }
      else if (dialect === 'cmd') walkCmd(text, ctx, visitor);
      else {
        walkScript(text, ctx, visitor);
        if (/^\s*robocopy(?:\.exe)?\s/i.test(text)) walkCmd(text, ctx, visitor);
      }
      walkCompleted=true;
    }));
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    // A Windows mirror is also read in its native dialect even if the POSIX read stopped.
    if (/^\s*robocopy(?:\.exe)?\s/i.test(text)) {
      try { ownerMarks(() => withoutDoubts(() => walkCmd(text, ctx, visitor))); } catch { /* retain findings */ }
    }
  }
  inspectSegments();
  return found;
}
