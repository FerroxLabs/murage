// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { shippedEngineSpecs } from './engine-inventory.mjs';
// Expected parity cells are fixed expectations, never learned from the candidate.
const row = (id, actor, level, expected, extra = {}) => ({ id, actor, level, expected, ...extra });
export const scenarios = [
  ...['ssh-local', 'cd', 'cd-ls', 'commit-push-remove', 'file-edit', 'browser', 'browser-next-turn', 'created-seat']
    .map(id => row(id, 'owner', 'unlimited', 'RUN')),
  row('python-alias-wipe', 'owner', 'unlimited', 'CARD', { why: 'wipe', cls: 'root' }),
  ...['email-subject-rm', 'peer-text-rm', 'memory-text-rm', 'web-pull-then-cmds', 'owner-room-turn', 'question-conversational'].map(id => row(id, 'owner', 'unlimited', 'RUN')),
  ...['owner-routine-schedule', 'routine-wake', 'project-room-routine'].map(id => row(id, 'routine', 'unlimited', 'RUN')),
  row('deny-host-declined', 'owner', 'unlimited', 'OFF_WITH_LINE', { feature:'host-computer' }),
  row('deny-browser-never', 'owner', 'unlimited', 'RUN', { permissionRule:true }),
  row('webhook-routine', 'webhook', 'unlimited', 'RUN'),
  row('wipe-home', 'owner', 'unlimited', 'CARD', { why: 'wipe', cls: 'home', rule: 'delete-home', allowedRules: ['delete-home', 'plainWipe'] }),
  row('deny-script', 'owner', 'unlimited', 'RUN', { permissionRule:true }),
  row('deny-host-permission-rule', 'owner', 'unlimited', 'RUN', { permissionRule:true }),
  row('webhook-read', 'webhook', 'unlimited', 'RUN'),
  row('webhook-write', 'webhook', 'unlimited', 'RUN'),
  ...['ask', 'auto', 'full', 'unlimited'].map(level => row(`routine-${level}`, 'routine', level, level === 'ask' ? 'CARD' : 'RUN')),
  ...['ask', 'auto', 'full'].map(level => row(`parity-${level}`, 'owner', level, level === 'ask' ? 'CARD' : 'RUN')),
];
// r3/r3.1 additions: fixed before the candidate runs.
scenarios.push(
 row('switch-ask-to-nolimits', 'owner', 'unlimited', 'RUN', { initialLevel: 'ask' }),
 row('switch-nolimits-to-ask', 'owner', 'ask', 'CARD', { initialLevel: 'unlimited' }),
 ...['deny-app-denied','deny-app-revoked'].map(id => row(id, 'owner', 'unlimited', 'RUN', { permissionRule:true })),
 row('cron-write-cards', 'owner', 'unlimited', 'RUN'),
 ...['cron-read-runs','benign-quoted-mkfs','heredoc-data','py-literal','queued-owner-drain','two-questions','question-with-instruction'].map(id => row(id, 'owner', 'unlimited', 'RUN')),
 row('webhook-in-owner-room', 'webhook', 'unlimited', 'RUN'),
 ...['project-routine-owner-room','routine-captured-auto'].map(id => row(id, 'routine', 'unlimited', 'RUN')),
);
export const engineSpecs = shippedEngineSpecs();
export const paritySources = [
  '1.0.18 guest/non-owner Ask parity, including Full access bots',
  'server/routine-permissions-api.test.ts (routine ceilings)',
  'scripts/smoothness/smooth.mjs S4/S10 (Ask/Auto/Full access ordinary shell)',
];
// Field inputs execute through the same candidate tool route as all other rows.
// An absent parser is a product failure, never a hard-coded dependency verdict.
export const fieldRows = [
 row('sable-bash-after-web','owner','unlimited','RUN',{tool:'Bash',input:{command:'echo fixture'},outside:'web-read',expectedCards:0}),
 row('sable-write-earlier-turn','owner','unlimited','RUN',{tool:'Write',input:{file_path:'fixture.txt',content:'fixture'},outside:'earlier-turn',expectedCards:0}),
 row('sable-mcp-after-outside','owner','unlimited','RUN',{tool:'mcp__fixture__write',input:{text:'fixture'},outside:'outside-content',expectedCards:0}),
 row('sable-unreadable-heredoc','owner','unlimited','RUN',{tool:'Bash',input:{command:'cat <<EOF > "$fixture_target"\nfixture\nEOF'},outside:'unreadable',expectedCards:0}),
 row('sable-unreadable-redirect','owner','unlimited','RUN',{tool:'Bash',input:{command:'printf fixture > "${fixture_target}"'},outside:'unreadable',expectedCards:0}),
 row('wipe-home-assignment','owner','unlimited','CARD',{tool:'Bash',input:{command:'nolim_wipe=~; rm -rf "${nolim_wipe:?}"'},why:'wipe',cls:'home',expectedCards:1}),
];
scenarios.push(...fieldRows);
// Guest threads never inherit a level. Only the owner's explicit 1.0.19+
// bot setting applies as set; upgraded legacy flags do not establish it.
for (const actor of ['guest', 'non-owner']) for (const botLevel of ['full', 'unlimited'])
 scenarios.push(row(`${actor}-legacy-${botLevel}`, actor, 'ask', 'CARD', { botLevel, legacy:true, origin:'channel-dm', why:'base', requiresAsk:true }));
for (const actor of ['guest', 'non-owner']) for (const botLevel of ['full', 'unlimited'])
 scenarios.push(row(`${actor}-explicit-${botLevel}`, actor, botLevel, 'RUN', { botLevel, permissionExplicit:true, origin:'channel-dm' }));
scenarios.push(row('missing-origin', 'non-owner', 'ask', 'CARD', { botLevel:'unlimited', missingOrigin:true, requiresAsk:true, why:'base' }));
for (const origin of ['phone', 'channel-dm']) {
 scenarios.push(row(`owner-${origin}`, 'owner', 'unlimited', 'RUN', { origin, channelMessages:true }));
 if(origin==='channel-dm') scenarios.push(row(`owner-${origin}-off`, 'owner', 'unlimited', 'OFF_WITH_LINE', { botLevel:'unlimited', origin, channelMessages:false, feature:'channel-messages' }));
}
for (const id of ['protected-symlink-write', 'release-input-changed', 'opaque-eval', 'owner-restart', 'owner-missing-live-record'])
 scenarios.push(row(id, 'owner', 'unlimited', 'RUN'));
scenarios.push(row('windows-powershell', 'owner', 'unlimited', 'RUN', { shell:'powershell' }));
scenarios.push(row('windows-home-wipe', 'owner', 'unlimited', 'CARD', { shell:'powershell', why:'wipe', cls:'home' }));

// The known missing-input shape has its own witnessed live row. Additional
// corpus shapes must be bound explicitly; Q5 rejects an absent id.
scenarios.push(row('unavailable-shell-missing-input','owner','unlimited','RUN',{availabilityWitness:{tool:'shell',shape:'missing-input'}}));
export function assertReleaseReady(rows=scenarios){
 const dependent=rows.filter(r=>r.dep);
 if(dependent.length)throw Error(`release has unresolved dependencies: ${dependent.map(r=>`${r.id}:${r.dep}`).join(', ')}`);
}

// Unknown targets are not a catastrophe; naming home is independently a wipe.
scenarios.push(row('unknown-delete', 'owner', 'unlimited', 'RUN'));
scenarios.push(row('unknown-delete-home', 'owner', 'unlimited', 'CARD', { why:'wipe', cls:'home' }));

// Capability switches remove the tool independently of permission level.
for (const level of ['ask','auto','full','unlimited']) for (const feature of ['browser','app-integration'])
 scenarios.push(row(`${feature}-off-${level}`, 'owner', level, 'OFF_WITH_LINE', { feature, capabilityDisabled:true }));
