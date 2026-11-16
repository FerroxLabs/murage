// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline witness: execute verbatim, hash-pinned regions of the published
// package. Gateway/model/transport are fixtures; permission/relay code is real.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

export function loadOpenclawPackage(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'openclaw' || pkg.version !== '2026.10.5') throw new Error('Expected cached OpenClaw 2026.10.5');
  const files = {};
  const region = (file, name) => {
    const text = readFileSync(join(root, 'dist', file), 'utf8');
    files[file] = createHash('sha256').update(text).digest('hex');
    const marker = `//#region ${name}\n`;
    const start = text.indexOf(marker);
    if (start < 0) throw new Error(`Missing upstream region ${name}`);
    const end = text.indexOf('//#endregion', start);
    if (end < 0) throw new Error(`Unclosed upstream region ${name}`);
    return text.slice(start + marker.length, end);
  };
  const code = [
    region('string-coerce-1VuiLaaR.mjs', 'packages/normalization-core/src/string-coerce.ts'),
    region('exec-approvals-core-s7tTQC_a.mjs', 'src/infra/exec-approvals-core.ts'),
    region('exec-approvals-policy-BUCGxklR.mjs', 'src/infra/exec-approvals-policy.ts'),
    region('gateway-caller-context-C-_kezG_.mjs', 'src/agents/session-permission-exec-mode.ts'),
    region('sessions-patch-_LW-92XG.mjs', 'src/gateway/session-execution-settings.ts'),
    region('get-reply-DE-fUW_A.mjs', 'src/auto-reply/reply/directive-parsing.ts'),
    region('get-reply-DE-fUW_A.mjs', 'src/auto-reply/reply/exec/directive.ts'),
    region('server-DkfYuk25.mjs', 'src/acp/permission-relay.ts'),
    region('server-DkfYuk25.mjs', 'src/acp/translator.agent-events.ts'),
  ].join('\n');
  const api = runInNewContext(`${code}\n({ applySessionExecutionSettings, resolveSessionPermissionExecPolicy, extractExecDirective, requiresExecApproval, AcpTranslatorAgentEvents })`, { structuredClone, console });
  return { ...api, packageVersion: pkg.version, files };
}
