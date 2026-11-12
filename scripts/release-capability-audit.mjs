// The security boundary is credential reachability, not shell syntax.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import { parse } from 'yaml';
import { auditReleaseMutations, trackedFiles } from './release-mutation-audit.mjs';
import { classifyDraftAssembly } from './release-assembly-inventory.mjs';
import { interpreterFileInvocations, repositoryTarget } from './release-interpreter-invocations.mjs';

export const RELEASE_WORKFLOW = '.github/workflows/release.yml';
export const RELEASE_JOB = 'assemble';
export const RELEASE_ACTIONS = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
];
export const RELEASE_COMMANDS = ['bootstrap', 'probe-prepared', 'wait-stage', 'download', 'notes-file', 'upload-prepared', 'verify-digests', 'publish-prepared'];
// These credentials identify/sign packages or reach test machines; none is a
// GitHub release credential. Unknown secrets fail closed and require review.
export const NON_RELEASE_SECRETS = new Set([
  'MAC_CERT_P12_BASE64', 'MAC_CERT_PASSWORD', 'APPLE_API_KEY_P8_BASE64',
  'APPLE_API_KEY_ID', 'APPLE_API_ISSUER_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET', 'RELEASE_GPG_PRIVATE_KEY', 'RELEASE_GPG_PASSPHRASE',
  'BUILD_HOST_SSH_KEY', 'BUILD_HOST_NAME', 'FLUX_CONTRACT_KEY',
]);

// GitHub expressions use single-quoted strings with doubled quote escapes.
// Read through quoted `}}` instead of treating it as the expression boundary;
// plain shell comments/prose mentioning "secrets" are not context access.
function expressionCode(text, implicit = false) {
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    const start = implicit ? 0 : text.indexOf('${{', offset);
    if (start < 0) break;
    let i = implicit ? start : start + 3, quoted = false, code = '';
    for (; i < text.length; i++) {
      if (text[i] === "'") {
        if (quoted && text[i+1] === "'") { i++; continue; }
        quoted = !quoted; code += ' '; continue;
      }
      if (!quoted && !implicit && text.slice(i,i+2) === '}}') break;
      code += quoted ? ' ' : text[i];
    }
    chunks.push(code);
    if (implicit) break;
    offset = i + 2;
  }
  return chunks.join(' ');
}

// Parsing unchanged script bodies dominates mutant suites. Results depend only
// on the filename and exact source, so overrides always invalidate this cache.
const operationCache = new Map();

export function auditReleaseCapabilities(root, overrides = new Map(), files = trackedFiles(root)) {
  const errors = [], secrets = [], workflows = [], references = [], assemblies = [], documents = new Map();
  const names = new Set([...files, ...overrides.keys()]);
  const fail = (file, path, reason) => errors.push({file, path, reason});
  const inspectedScripts = new Set(), inspectedPackages = new Set();
  const read = file => overrides.get(file) ?? readFileSync(resolve(root, file), 'utf8');
  function operations(source, file, path, script, javascript = script ? /\.[cm]?[jt]sx?$/.test(script) : path.endsWith('.script')) {
    // YAML is already parsed: inspect executable step bodies, not comments or
    // unrelated scalar values. Script inspection uses the mutation lint's AST.
    // Reached scripts are executable even when their suffix denotes saved data.
    const executable = javascript && script && /\.[cm]?[jt]sx?$/.test(script)
      ? script : `${script ?? file}.${javascript ? 'mjs' : 'sh'}`;
    let cached = operationCache.get(executable);
    if (cached?.source !== source) {
      cached = {source, report: auditReleaseMutations(root, new Map([[executable, source]]), [executable], {releaseGetOnly:true})};
      operationCache.set(executable, cached);
    }
    const report = cached.report;
    for (const hit of report.errors) fail(file, path, `release operation outside assemble: ${hit.form}${script ? ` in ${script}:${hit.line}` : ''}`);
    // Retain the existing shell inspection for shell-labelled sources even if
    // a caller names a JavaScript interpreter; also inspect its actual syntax.
    if (javascript && script && /\.(?:sh|zsh|ps1|cmd|bat)$/.test(script)) operations(source, file, path, script, false);
    function follow(target, relative = false, javascript) {
      const name = repositoryTarget(root, relative ? posix.join(posix.dirname(script ?? file), target) : target);
      if (!name) return;
      const key = `${name}:${javascript ?? 'auto'}`;
      if (name.startsWith('../') || name.startsWith('/') || inspectedScripts.has(key)) return;
      if (!overrides.has(name) && (!existsSync(resolve(root, name)) || !statSync(resolve(root, name)).isFile())) return;
      inspectedScripts.add(key);
      operations(read(name), file, path, name, javascript);
    }
    for (const call of interpreterFileInvocations(source, javascript)) {
      if (call.target !== undefined) follow(call.target, false, call.javascript);
      else operations(call.inline, file, path, undefined, call.javascript);
    }
    for (const match of source.matchAll(/(?:^|\s)\.\/["']?([\w./-]+)/g)) follow(match[1]);
    if (javascript) {
      // Static imports, re-exports, require and literal dynamic imports.
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\(\s*)["'](\.[^"']+)["']/g)) follow(match[1], true);
    }
    for (const match of source.matchAll(/\b(?:pnpm|npm\s+run|yarn)\s+(?:run\s+)?([\w:-]+)/g)) {
      const name = match[1];
      if (inspectedPackages.has(name)) continue;
      inspectedPackages.add(name);
      const command = JSON.parse(read('package.json')).scripts?.[name];
      if (command) operations(command, file, path);
    }
  }
  for (const file of [...names].sort()) {
    if (!/^\.github\/workflows\/.*\.ya?ml$/.test(file) && !/(?:^|\/)action\.ya?ml$/.test(file)) continue;
    try { documents.set(file, parse(overrides.get(file) ?? readFileSync(resolve(root, file), 'utf8'), { uniqueKeys: true })); }
    catch (error) { fail(file, '', `invalid YAML: ${error.message}`); }
  }
  const expectedWriters = new Map([
    [`${RELEASE_WORKFLOW}:assemble`, {contents:'write', actions:'read'}],
    ['.github/workflows/prepare-release.yml:open-pr', {contents:'write', 'pull-requests':'write', actions:'write'}],
    ['.github/workflows/cla.yml:record', {contents:'write'}],
  ]);
  const writers = new Set();
  const readOnly = p => p && typeof p === 'object' && !Array.isArray(p) && Object.values(p).every(v => ['read', 'none'].includes(v));
  const equal = (a,b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b).sort());
  for (const [file, doc] of documents) {
    const workflow = file.startsWith('.github/workflows/');
    if (workflow && !readOnly(doc?.permissions)) fail(file, 'permissions', 'explicit read-only contents required');
    const jobs = workflow ? doc?.jobs ?? {} : {};
    const isReusable = workflow && (doc?.on === 'workflow_call' || (Array.isArray(doc?.on) ? doc.on.includes('workflow_call') : Object.hasOwn(doc?.on ?? {}, 'workflow_call')));
    if (isReusable && doc.on.workflow_call?.secrets) fail(file, 'on.workflow_call.secrets', 'reusable workflows cannot accept secrets');
    workflows.push(...(workflow ? [{file, permissions: doc?.permissions, jobs: Object.fromEntries(Object.entries(jobs).map(([id,j]) => [id,j.permissions ?? doc.permissions]))}] : []));
    for (const [id, job] of Object.entries(jobs)) {
      const privileged = file === RELEASE_WORKFLOW && id === RELEASE_JOB;
      const assembly = classifyDraftAssembly(file, id, job);
      if (assembly) assemblies.push({file, job: id, ...assembly});
      const key = `${file}:${id}`, expectedPermissions = assembly ? {contents:'write'} : expectedWriters.get(key);
      if (expectedPermissions) {
        writers.add(key);
        if (!equal(job.permissions, expectedPermissions)) fail(file, `jobs.${id}.permissions`, 'write job must have exactly its reviewed permissions');
        if (isReusable || job.uses) fail(file, `jobs.${id}`, 'write jobs cannot be reusable');
        if (doc.env || doc.defaults || job.env || job.defaults || job.container || job.services || job.environment || job.strategy || job['continue-on-error']) fail(file, `jobs.${id}`, 'write execution context must not be overridden');
      } else if (job.permissions !== undefined && !readOnly(job.permissions)) fail(file, `jobs.${id}.permissions`, 'job outside exact write allowlist');
      if (expectedPermissions && !privileged && !assembly) {
        const prep = id === 'open-pr';
        const ref = prep ? '${{ needs.prepare.outputs.sha }}' : '${{ github.event.repository.default_branch }}';
        const expected = [
          {uses:RELEASE_ACTIONS[0],with:{ref, 'persist-credentials':false}},
          {uses:RELEASE_ACTIONS[1],with:{'node-version':24,'package-manager-cache':false}},
          {run:`node scripts/${prep ? 'release-preparation' : 'cla-record'}.mjs`,env:{GH_TOKEN:'${{ github.token }}',...(prep ? {VERSION:'${{ needs.prepare.outputs.version }}',SHA:'${{ needs.prepare.outputs.sha }}'} : {})}},
        ];
        if (JSON.stringify(job.steps) !== JSON.stringify(expected)) fail(file, `jobs.${id}.steps`, 'administrative steps must match the reviewed fixed commands, setup and inputs');
        if (prep && JSON.stringify(job.needs) !== JSON.stringify(['prepare'])) fail(file, `jobs.${id}.needs`, 'preparation must pass its prerequisite first');
        for (const step of job.steps ?? []) if (step.env?.GH_TOKEN !== undefined && step.env.GH_TOKEN !== '${{ github.token }}') fail(file, `jobs.${id}.steps`, 'administrative credential must be GITHUB_TOKEN');
        if (!prep && (!doc.on?.issue_comment || !doc.on?.workflow_dispatch?.inputs?.pr_number?.required)) fail(file, 'on', 'CLA comment and PR-number recheck must be wired');
      }
      if (privileged) {
        if (isReusable || job.uses || job.permissions?.contents !== 'write') fail(file, `jobs.${id}`, 'only the non-reusable release job may write');
        if (doc.env || doc.defaults || job.env || job.defaults || job.container || job.services || job.environment || job.strategy) fail(file, `jobs.${id}`, 'release execution context must not be overridden');
        const steps = job.steps ?? [];
        for (const [i, step] of steps.entries()) {
          const path = `jobs.${id}.steps.${i}`;
          if (i < 2) {
            if (step.uses !== RELEASE_ACTIONS[i] || step.run || step.env) fail(file, path, 'release setup action must match the full-SHA allowlist');
            const expected = i === 0 ? {ref: '${{ needs.prepare.outputs.sha }}', 'persist-credentials': false} : {'node-version': 24, 'package-manager-cache': false};
            if (JSON.stringify(step.with) !== JSON.stringify(expected)) fail(file, path, 'unexpected release setup inputs');
          } else {
            const command = String(step.run ?? '').trim().replace(/^node scripts\/release-guard\.mjs /, '');
            if (step.uses || !RELEASE_COMMANDS.includes(command) || step.run?.trim() !== `node scripts/release-guard.mjs ${command}`) fail(file, path, 'release steps must be fixed release-guard commands');
            if (step.shell || step['working-directory']) fail(file, path, 'release shell or directory override');
            for (const key of Object.keys(step.env ?? {})) if (!['GH_TOKEN','VERSION','SHA','RELEASE_ID','WAIVER_PATH','WAIVER_SHA256','WAIVER_RUN','WAIVER_RUN_URL','WAIVER_APPROVAL','REVIEW_FILE'].includes(key)) fail(file, path, `unexpected release environment: ${key}`);
          }
          if (step['continue-on-error']) fail(file, path, 'release failures must stop the job');
        }
        if (JSON.stringify(job.needs) !== JSON.stringify(['prepare'])) fail(file, `jobs.${id}.needs`, 'sole writer must start before builds');
        for (const step of steps.slice(2, -1)) if (step.if) fail(file, `jobs.${id}.steps`, 'release barriers must be unconditional');
        const probe = steps.find(step => step.run === 'node scripts/release-guard.mjs probe-prepared');
        if (probe?.name !== 'Probe release token before builds' || probe?.env?.GH_TOKEN !== '${{ secrets.RELEASES_PAT }}') fail(file, `jobs.${id}.steps`, 'required early token probe missing');
        if (jobs.preflight?.steps?.at(-1)?.run !== 'node scripts/release-guard.mjs wait-probe' || JSON.stringify(jobs.preflight?.needs) !== JSON.stringify(['prepare'])) fail(file, 'jobs.preflight', 'read-only probe gate required');
        if (jobs.preflight?.['continue-on-error'] || jobs.preflight?.steps?.some(step => step.if || step['continue-on-error'])) fail(file, 'jobs.preflight', 'probe failures cannot be skipped or ignored');
        for (const platform of ['mac','mac-x64','windows','linux']) if (![jobs[platform]?.needs].flat().includes('preflight')) fail(file, `jobs.${platform}.needs`, 'build must wait for token probe');
        for (const dependency of ['prepare','ci-gate','mac','mac-x64','windows','linux']) if (![jobs.stage?.needs].flat().includes(dependency)) fail(file, 'jobs.stage.needs', 'staging must wait for CI and every build');
        if (steps.length !== RELEASE_COMMANDS.length + 2 || RELEASE_COMMANDS.some((command,i) => steps[i+2]?.run?.trim() !== `node scripts/release-guard.mjs ${command}`)) fail(file, `jobs.${id}.steps`, 'release commands must run in the reviewed order');
      }
      if (job.uses && (job.permissions?.contents === 'write' || job.secrets)) fail(file, `jobs.${id}`, 'reusable calls cannot receive release credentials or inherited secrets');
    }
    function visit(value, path = []) {
      if (typeof value === 'string') {
        const location = path.join('.');
        const privileged = file === RELEASE_WORKFLOW && path[0] === 'jobs' && path[1] === RELEASE_JOB;
        const assembly = path[0] === 'jobs' && classifyDraftAssembly(file, path[1], jobs[path[1]]);
        if (!privileged && !assembly && ['run', 'script'].includes(path.at(-1))) operations(value, file, location);
        if (!workflow && path[0] === 'runs' && ['main', 'pre', 'post'].includes(path.at(-1))) {
          const target = posix.join(posix.dirname(file), value);
          operations(read(target), file, location, target);
        }
        // Reject dynamic/bracket/whole-context secret access; inventory every
        // literal secrets.* occurrence, including conditions and action inputs.
        const code = expressionCode(value, path.at(-1) === 'if' && !value.includes('${{'));
        const refs = [...code.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z_0-9]*)/gi)];
        if (/\bsecrets\b/i.test(code.replace(/\bsecrets\.[A-Za-z_][A-Za-z_0-9]*/gi, ''))) fail(file, location, 'unclassified secret access');
        if (path.at(-1) === 'secrets' && value === 'inherit') fail(file, location, 'inherited secrets forbidden');
        for (const [,rawName] of refs) {
          const name = rawName.toUpperCase();
          secrets.push({file, path: location, name});
          const builtin = name === 'GITHUB_TOKEN';
          const guardedEnv = privileged && path[2] === 'steps' && path[4] === 'env' && path[5] === 'GH_TOKEN' && ['probe-prepared','wait-stage','download','notes-file','upload-prepared','verify-digests','publish-prepared'].some(command => jobs[RELEASE_JOB].steps[Number(path[3])]?.run === `node scripts/release-guard.mjs ${command}`);
          if ((name === 'RELEASES_PAT' || (builtin && privileged)) && !guardedEnv) fail(file, location, 'release credential outside a guarded step env');
          else if (!builtin && name !== 'RELEASES_PAT' && !NON_RELEASE_SECRETS.has(name)) fail(file, location, `unclassified secret: ${name}`);
        }
        if (privileged && /\bgithub\s*(?:\.\s*token\b|\[)/i.test(code)) {
          const step = jobs[RELEASE_JOB].steps[Number(path[3])];
          if (path[2] !== 'steps' || path[4] !== 'env' || path[5] !== 'GH_TOKEN' || !['wait-stage','download','notes-file'].some(command => step?.run === `node scripts/release-guard.mjs ${command}`)) fail(file, location, 'write-scoped GitHub token outside guarded env');
        }
        if (path.at(-1) === 'uses') {
          references.push({file, path: location, target: value});
          if (value.startsWith('./')) {
            const local = posix.normalize(value.slice(2));
            const targets = /\.ya?ml$/.test(local) ? [local] : [`${local}/action.yml`, `${local}/action.yaml`];
            if (!targets.some(target => documents.has(target))) fail(file, location, 'local workflow/action must be parsed');
          }
        }
      } else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
    visit(doc);
  }
  for (const key of expectedWriters.keys()) if (!writers.has(key)) fail(RELEASE_WORKFLOW, 'jobs', `missing required write job: ${key}`);
  // MAIN's invocation rule applies to every tracked caller, including package
  // commands and scripts not currently referenced by a workflow. Discovery uses
  // the same parser as the inventory; passive evidence never becomes a root.
  let invoked = [];
  try { invoked = auditReleaseMutations(root, overrides, files, {invocationsOnly: true}).executables; }
  catch (error) { fail(RELEASE_WORKFLOW, 'invocations', `invalid executable configuration: ${error.message}`); }
  for (const target of invoked) {
    const key = `${target.file}:${target.javascript}`;
    if (inspectedScripts.has(key)) continue;
    inspectedScripts.add(key);
    operations(read(target.file), target.file, 'interpreter target', target.file, target.javascript);
  }
  return {errors, workflows, secrets, references, assemblies};
}
