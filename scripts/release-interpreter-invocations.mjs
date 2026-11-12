import { posix, relative, resolve } from 'node:path';
import ts from 'typescript';

// Option parsing supplies context (especially inline code), never an exemption
// from file inspection. Both audits use interpreterFileInvocations below.
export function interpreterInvocation(command, args) {
  const name = posix.basename(command).replace(/\.exe$/i, '');
  if (!/^(?:ba|da|z|k|a)?sh$|^(?:node(?:js)?|tsx|ts-node|python[\d.]*|perl|ruby|pwsh|powershell|source|\.)$/.test(name)) return;
  const javascript = /^(?:node(?:js)?|tsx|ts-node)$/.test(name);
  const powershell = /^(?:pwsh|powershell)$/.test(name);
  const shell = /sh$/.test(name);
  const python = /^python/.test(name);
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // A dynamic option/target cannot be resolved. Later arguments cannot hide
    // an already resolved target, and a known option value can be skipped.
    if (arg === undefined) return;
    if (options && arg === '--') { options = false; continue; }
    if (options && arg === '-') return; // stdin, not a repository target
    if (options && /^[-+]/.test(arg)) {
      const inline = shell ? /^-[a-z]*c[a-z]*$/.test(arg)
        : javascript ? /^(?:-[ep]|--eval|--print)$/.test(arg)
        : powershell ? /^-(?:c|command)$/i.test(arg)
        : python ? arg === '-c' : name === 'perl' ? /^-[eE]$/.test(arg) : name === 'ruby' && arg === '-e';
      if (inline) return args[i + 1] === undefined ? undefined : {inline: args[i + 1], javascript};
      if (powershell && /^-(?:f|file)$/i.test(arg)) { options = false; continue; }
      // Options taking a separate value must not turn that value into a file.
      const takesValue = shell ? /^[-+][a-zA-Z]*[oO]$|^--(?:rcfile|init-file|emulate)$/.test(arg)
        : javascript ? /^(?:-r|-C|--require|--import|--(?:experimental-)?loader|--input-type|--conditions|--inspect-port|--title|--icu-data-dir)$/.test(arg)
        : python ? /^(?:-W|-X|--check-hash-based-pycs)$/.test(arg)
        : name === 'ruby' ? /^(?:-[CEFIKr]|--encoding|--external-encoding|--internal-encoding|--enable|--disable|--dump|--backtrace-limit)$/.test(arg)
        : name === 'perl' ? /^-[IMmF]$/.test(arg)
        : powershell && /^-(?:ExecutionPolicy|WorkingDirectory|ConfigurationName|ConfigurationFile|InputFormat|OutputFormat)$/i.test(arg);
      if (takesValue) i++;
      if (python && arg === '-m') return; // module, not a file operand
      if (name === 'ruby' && arg === '-S') options = false;
      continue;
    }
    return {target: arg, javascript};
  }
}

const javascriptCache = new Map();
export function interpreterInvocations(source, javascript = false) {
  return collectInvocations(source, javascript, false);
}

// MAIN 2026-11-11 13:25Z: every literal operand is a candidate file, including
// option values and operands after dynamic arguments or spreads. Callers check
// repository membership/existence; option arity cannot remove a candidate.
export function interpreterFileInvocations(source, javascript = false) {
  return collectInvocations(source, javascript, true);
}

export function repositoryTarget(root, target) {
  const name = relative(resolve(root), resolve(root, target));
  if (name === '..' || name.startsWith('../') || posix.isAbsolute(name)) return;
  return name;
}

function collectInvocations(source, javascript, fileCandidates) {
  if (!/\b(?:bash|dash|zsh|ksh|ash|sh|node|nodejs|tsx|ts-node|python[\d.]*|perl|ruby|pwsh|powershell|source)\b/.test(source) && !/(?:^|\s)\.\s+/.test(source)) return [];
  const cacheKey = `${fileCandidates}:${source}`;
  if (javascript && javascriptCache.has(cacheKey)) return javascriptCache.get(cacheKey);
  const calls = [];
  const add = (command, args, contextArgs = args) => {
    const kind = interpreterInvocation(command, ['__candidate__']);
    if (!kind) return;
    const found = new Map();
    const remember = call => { if (call) found.set(JSON.stringify(call), call); };
    if (fileCandidates) {
      for (let i = 0; i < args.length; i++) {
        const target = args[i];
        if (typeof target !== 'string') continue;
        remember({target, javascript: kind.javascript});
        // Inline syntax adds code inspection alongside the file candidates.
        const context = interpreterInvocation(command, args.slice(i));
        if (context?.inline !== undefined) remember(context);
      }
    }
    const call = interpreterInvocation(command, contextArgs);
    remember(call);
    calls.push(...found.values());
  };
  if (javascript) {
    const tree = ts.createSourceFile('invocations.mjs', source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && /(?:^|\.)(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?|run|checked|execa(?:Sync)?|system|execute)$/.test(node.expression.getText(tree))) {
        const [command, args] = node.arguments;
        if (command && ts.isStringLiteralLike(command)) {
          // Resolve the interpreter's operands independently. Unknown script
          // arguments after a literal target (including spreads) are irrelevant.
          if (args && ts.isArrayLiteralExpression(args)) {
            // A spread has unknown length. Nothing after it has a known index.
            const spread = args.elements.findIndex(ts.isSpreadElement);
            const operands = spread < 0 ? args.elements : args.elements.slice(0, spread);
            const literal = arg => ts.isStringLiteralLike(arg) ? arg.text : undefined;
            add(command.text, args.elements.map(literal), operands.map(literal));
          }
          else calls.push(...collectInvocations(command.text, false, fileCandidates));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    javascriptCache.set(cacheKey, calls);
    return calls;
  }
  // Preserve quoted operands (notably -c code) and command boundaries. Ignore
  // comments and escaped newlines; flags belong to the interpreter, not targets.
  const tokens = [...source.replace(/\\\r?\n/g, ' ').matchAll(/#[^\n]*|"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()<>`]+|[\n;&|()<>`]/g)]
    .filter(match => !match[0].startsWith('#'))
    .map(match => /^['"]/.test(match[0]) ? match[0].slice(1, -1) : match[0]);
  for (let i = 0; i < tokens.length; i++) {
    if (i && !/^[\n;&|()<>`]$/.test(tokens[i - 1]) && !/^(?:then|do|if|elif|while|until|!|exec|command|env|sudo)$/.test(tokens[i - 1]) && !/^[A-Za-z_]\w*=/.test(tokens[i - 1])) continue;
    let end = i + 1;
    while (end < tokens.length && !/^[\n;&|()<>`]$/.test(tokens[end])) end++;
    add(tokens[i], tokens.slice(i + 1, end));
  }
  return calls;
}
