// Secondary mutation lint (not a security boundary). Every tracked file is read; executable syntax is
// inspected, so strings used as negative fixtures are not executable exemptions.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import ts from 'typescript';
import { parse } from 'yaml';
import { classifyDraftAssembly } from './release-assembly-inventory.mjs';
import { interpreterFileInvocations, repositoryTarget } from './release-interpreter-invocations.mjs';

export function trackedFiles(root) {
  // Container checkouts have no access to the host worktree's git directory.
  // The runner supplies the exact NUL-delimited git ls-files output in that case.
  return (process.env.RELEASE_AUDIT_INDEX
    ? readFileSync(process.env.RELEASE_AUDIT_INDEX, 'utf8')
    : execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8' }))
    .split('\0').filter(Boolean);
}

export function auditReleaseMutations(root, overrides = new Map(), files = trackedFiles(root), { releaseGetOnly = false, invocationsOnly = false } = {}) {
  const hits = [], errors = [];
  const names = new Set([...files, ...overrides.keys()]);
  const reached = new Map(), inspected = new Set();
  const read = file => overrides.get(file) ?? readFileSync(resolve(root, file), 'utf8');
  function invocations(file, source, javascript = false) {
    for (const call of interpreterFileInvocations(source, javascript)) {
      if (call.target !== undefined) {
        const target = repositoryTarget(root, call.target);
        if (target && (overrides.has(target) || (existsSync(resolve(root, target)) && statSync(resolve(root, target)).isFile()))) reached.set(`${target}:${call.javascript}`, {file: target, javascript: call.javascript});
      } else inspect(file, call.inline, call.javascript);
    }
  }
  const add = (file, form, line, owner, guarded = false, assembly) => {
    const hit = { file, form, line, owner: owner ?? '<top-level>' };
    if (assembly) Object.assign(hit, {owner: assembly.owner, classification: assembly.kind, reason: assembly.reason});
    hits.push(hit);
    if (!assembly && (file !== 'scripts/release-guard.mjs' || !guarded)) errors.push(hit);
  };
  function shell(file, text, line = 1, owner, guarded, assembly) {
    // Join POSIX/PowerShell continuations; permit either API option order,
    // explicit methods and gh's implicit POST when fields/input are supplied.
    const source = text.replace(/\\\r?\n|`\r?\n/g, ' ');
    invocations(file, source);
    if (invocationsOnly) return;
    if (!releaseGetOnly && file !== 'scripts/release-guard.mjs' && /https:\/\/(?:api|uploads)\.github\.com\//.test(source) &&
        /\b(?:curl|wget|Invoke-RestMethod|Invoke-WebRequest)\b/.test(source) &&
        /(?:-X\s*|--(?:request|method)[=\s]+|-Method\s+)["']?(?:POST|PATCH|PUT|DELETE)\b|--(?:data(?:-\w+)?|json|post-data|post-file)\b/.test(source)) add(file, 'GitHub API URL with mutating shell command', line, owner, guarded);
    const urls = new Map([...source.matchAll(/^\s*(?:export\s+)?(\w+)=["']?(https:\/\/[^\s"']+)/gm)].map(m => [m[1], m[2]]));
    for (let command of source.split(/[\n;]/)) {
      if (/^\s*#/.test(command)) continue;
      if (releaseGetOnly) {
        command = command.replace(/\$\{(\w+)\}|\$(\w+)/g, (literal, braced, plain) => urls.get(braced ?? plain) ?? literal);
        if (/\/releases\b/.test(command) && /\b(?:gh\s+api|curl|wget|Invoke-RestMethod|Invoke-WebRequest)\b/.test(command)) {
          const methods = [...command.matchAll(/(?:^|\s)(?:--(?:method|request)(?:=|\s+)|-X\s*|-[Mm]ethod\s+)["']?([^\s"']+)/g)].map(m => m[1]);
          const implicitPost = /(?:^|\s)(?:-d|--data(?:-\w+)?|--json|--post-data|--post-file)(?:[=\s]|$)/.test(command) ||
            (/\bgh\s+api\b/.test(command) && /(?:^|\s)(?:-[fF]|--(?:raw-)?field|--input)(?:[=\s]|$)/.test(command));
          const head = /(?:^|\s)(?:-I|--head|--spider)(?:\s|$)/.test(command);
          if (methods.some(method => method !== 'GET') || head || (!methods.length && implicitPost)) add(file, 'release API requires GET', line, owner, guarded);
        }
        // The shared guard contains both read and write commands. Its entry
        // prerequisite alone does not authorize callers outside assemble.
        const guard = command.match(/\b(?:node\s+)?scripts\/release-guard\.mjs\s+["']?([^\s"')]+)/);
        if (guard && !['bootstrap','wait-probe','wait-stage','download','verify-digests','version','should-release','next-version','absent','available','branch','verify-tag','browser-extension','browser-extension-optional','browser-extension-build','update-feed'].includes(guard[1])) add(file, 'release guard command requires assemble', line, owner, guarded);
      }
      if (/\bgh\s+release\s+(?:create|upload|edit|delete|delete-asset)\b/.test(command)) add(file, 'gh release mutation', line, owner, guarded, assembly);
      if (!releaseGetOnly && /\bgh\s+api\b/.test(command) && /\brepos\/\S*\/releases\b/.test(command) &&
          /(?:--method(?:=|\s+)|-X\s*)["']?(?:POST|PATCH|PUT|DELETE)\b|(?:^|\s)(?:-[fF]|--(?:raw-)?field|--input)(?:[=\s])/.test(command)) add(file, 'gh api mutation', line, owner, guarded);
      if (!releaseGetOnly && /\/releases\b/.test(command) && /\b(?:curl|wget|Invoke-RestMethod|Invoke-WebRequest)\b/.test(command) &&
          /(?:-X\s*|--(?:request|method)[=\s]+|-Method\s+)["']?(?:POST|PATCH|PUT|DELETE)\b|--(?:data(?:-\w+)?|json|post-data|post-file)\b|(?:^|\s)-d\b/.test(command)) add(file, 'REST mutation', line, owner, guarded);
      if (/\.(?:createRelease|updateRelease|uploadReleaseAsset|deleteRelease|deleteReleaseAsset)\s*\(/.test(command)) add(file, 'octokit mutation', line, owner, guarded);
      if (/--publish(?:[=\s]+)["']?(?:always|onTag|onTagOrDraft)\b/.test(command)) add(file, 'builder publish flag', line, owner, guarded);
    }
  }
  function config(file, value, key = '', assembly) {
    if (!value || typeof value !== 'object') return;
    for (const [name, item] of Object.entries(value)) {
      if (name === 'publish' && (typeof item === 'string' || Array.isArray(item) || item?.provider)) {
        if (item !== 'never') add(file, 'builder publisher', 1);
      }
      if (typeof item === 'string' && (name === 'run' || name === 'script' || key === 'scripts' || name === 'command')) shell(file, item, 1, undefined, false, assembly);
      config(file, item, name, key === 'jobs' ? classifyDraftAssembly(file, name, item) : assembly);
    }
  }
  function inspect(file, source, javascript) {
    if (javascript === true || (javascript === undefined && /\.(?:[cm]?[jt]sx?)$/.test(file))) {
      invocations(file, source, true);
      if (invocationsOnly) return;
      if (!releaseGetOnly && !/createRelease|updateRelease|uploadReleaseAsset|deleteRelease|\bgh\b|\/releases|\bpublish\b/.test(source)) return;
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const variables = new Map();
      function collect(node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) variables.set(node.name.text, node.initializer);
        ts.forEachChild(node, collect);
      }
      collect(tree);
      function value(node, depth = 0) {
        if (!node || depth > 5) return '';
        if (ts.isIdentifier(node)) return value(variables.get(node.text), depth + 1);
        if (ts.isStringLiteralLike(node)) return node.text;
        if (ts.isTemplateExpression(node)) return node.getText(tree).slice(1, -1);
        if (ts.isArrayLiteralExpression(node)) return node.elements.map(n => value(n, depth + 1)).join(' ');
        return node.getText(tree);
      }
      function visit(node) {
        if (!ts.isPropertyAssignment(node) && !ts.isCallExpression(node)) { ts.forEachChild(node, visit); return; }
        let owner = node.parent;
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
        const guarded = ts.isFunctionDeclaration(owner ?? tree) &&
          owner.body?.statements[0]?.getText(tree) === 'assertSignalReleaseReady();' &&
          /const \{ assertSignalReleaseReady \} = await import\(["']\.\/signal-release-prerequisites\.mjs["']\)/.test(source);
        const label = owner?.name?.getText(tree);
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        if (ts.isPropertyAssignment(node) && node.name.getText(tree).replace(/["']/g, '') === 'publish' &&
            (/\bprovider\s*[:=]/.test(value(node.initializer)) || /^(github|gitlab|s3|spaces|generic|keygen|snapStore|bitbucket)$/.test(value(node.initializer)))) add(file, 'builder publisher', line, label, guarded);
        if (ts.isCallExpression(node)) {
          const name = node.expression.getText(tree), args = node.arguments;
          if (/(?:\.|\[\s*["'])(?:createRelease|updateRelease|uploadReleaseAsset|deleteRelease|deleteReleaseAsset)(?:["']\s*\])?$/.test(name)) add(file, 'octokit mutation', line, label, guarded);
          // Command wrappers (including this repository's checked/run helpers).
          if (/^(?:gh|curl|wget|electron-builder)$/.test(value(args[0]))) shell(file, `${value(args[0])} ${value(args[1])}`, line, label, guarded);
          else if (/(?:^|\.)(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?|run|checked|execa(?:Sync)?|system|execute)$/.test(name) && args[0]) shell(file, value(args[0]), line, label, guarded);
          const call = args.map(n => value(n)).join(' ');
          const methodOption = args.some(arg => {
            const options = ts.isIdentifier(arg) ? variables.get(arg.text) : arg;
            return options && ts.isObjectLiteralExpression(options) && options.properties.some(property =>
              ts.isPropertyAssignment(property) && property.name.getText(tree).replace(/["']/g, '') === 'method' &&
              (releaseGetOnly ? value(property.initializer) !== 'GET' : /^(POST|PATCH|PUT|DELETE)$/i.test(value(property.initializer))));
          });
          if (releaseGetOnly && /\/releases\b/.test(call) && (
            /^(?!GET(?:\s|$))[A-Z]+(?:\s|$)/.test(value(args[0])) ||
            /\.(?:head|options)$/.test(name))) add(file, 'release API requires GET', line, label, guarded);
          if (/\/releases\b/.test(call) && (methodOption || /\.(?:post|patch|put|delete)$/.test(name) ||
              (/request$/.test(name) && /^(?:POST|PATCH|PUT|DELETE)\s+.*\/releases\b/.test(value(args[0]))))) add(file, 'REST mutation', line, label, guarded);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    } else if (javascript === false) {
      shell(file, source);
    } else if (/\.(?:json|ya?ml)$/.test(file)) {
      // All data files are parsed, including package scripts and nested/platform
      // builder overrides. Workflow dispatch booleans are not publishers.
      try {
        const data = file.endsWith('.json') ? JSON.parse(source) : parse(source);
        config(file, data);
        if (/(?:^|\/)electron-builder(?:[.-][^/]*)?\.(?:json|ya?ml)$/.test(file) && data?.publish !== null) add(file, 'builder requires explicit null publisher', 1);
      }
      catch (error) {
        // Some tracked documentation data is deliberately malformed. Still
        // inspect its text; executable configs must always parse successfully.
        if (/builder|package\.json$|^\.github\//.test(file)) throw new Error(`${file}: ${error.message}`);
        shell(file, source);
        if (/publish[\s\S]{0,100}provider\s*[:=]/.test(source)) add(file, 'builder publisher', 1);
      }
    } else if (/\.mdx?$/.test(file)) {
      for (const block of source.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) shell(file, block[1]);
    } else if (!/^evidence\/.*\.(?:log|diff|patch)$/.test(file) || /^#!/.test(source) ||
        (statSync(resolve(root, file), {throwIfNoEntry:false})?.mode & 0o111)) shell(file, source);
  }
  for (const file of [...names].sort()) {
    const source = read(file);
    inspect(file, source);
    // Remember the parser actually used, excluding passive saved output.
    if (!/\.(?:json|ya?ml|mdx?)$/.test(file) && (!/^evidence\/.*\.(?:log|diff|patch)$/.test(file) || /^#!/.test(source) ||
        (statSync(resolve(root, file), {throwIfNoEntry:false})?.mode & 0o111))) {
      inspected.add(`${file}:${/\.[cm]?[jt]sx?$/.test(file)}`);
    }
  }
  // Invocations override all data classifications, including evidence, JSON,
  // Markdown and misleading extensions. Follow chains until no target remains.
  for (const [key, call] of reached) {
    if (inspected.has(key)) continue;
    inspected.add(key);
    inspect(call.file, read(call.file), call.javascript);
  }
  return { files: files.length, hits, errors, executables: [...reached.values()] };
}
