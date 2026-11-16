// SPDX-License-Identifier: AGPL-3.0-or-later
// G-NL: isolated store, real permission resolver and registered decision ingress.
// Commands are policy inputs only. The fake transport never executes them.
import { afterEach, expect, it } from 'vitest';
import { autoVerdict, type AutoContext } from './auto-approve.ts';
import { installPermissionInheritance } from './permission-inheritance.ts';
import { permissionsForNoLimitsOrigin } from './no-limits-origin.ts';
import { botPermissionMode, routineTurnApproval } from './routine-permissions.ts';
import { fixture, d, baseCard } from './decision/fixture.ts';

const unlimited = { autoApprove: true, fullAccess: true, noLimits: true };
const profiles = [
  ['explicit No limits', { ...unlimited, permissionExplicit: true }, false],
  ['stored No limits revision zero', { ...unlimited, permissionRev: 0 }, false],
  ['inherited Ask', { autoApprove: false, permissionExplicit: false }, true],
  ['inherited Auto', { autoApprove: true, fullAccess: false }, true],
  ['inherited legacy Full access', { autoApprove: true, fullAccess: true, permissionRev: 0 }, true],
] as const;
const commands = ['touch notes.txt', 'cat .env', 'touch /etc/fixture-policy', 'eval "$FIXTURE_COMMAND"'];
let restore = () => {};
afterEach(() => restore());
for (const [name, bot, global] of profiles) {
  for (const path of ['routine', 'webhook', 'owner-channel', 'bot-created seat'] as const) {
    it(`G-NL ${name}: ${path} has no non-wipe permission card`, async () => {
      restore = installPermissionInheritance(() => global);
      const f = fixture();
      // The same live projection used before runtime decision registration.
      const actor = permissionsForNoLimitsOrigin(path === 'bot-created seat' ? 'owner' : path, bot);
      const context: AutoContext = { noLimitsOrigin: path === 'bot-created seat' ? 'owner' : path,
        fullAccessOrigin: path === 'routine' ? 'routine' : path === 'owner-channel' ? 'owner-channel' : path === 'webhook' ? 'other' : 'owner',
        routineLevel: path === 'routine', unattended: path === 'webhook', channelOwner: path === 'owner-channel' };
      const initiator: d.Initiator = path === 'routine'
        ? { k: 'routine-run', form: 'run', sourceRunId: 'run', sourceBotId: 'b', recipientGeneration: 'g', trigger: 'schedule' }
        : path === 'webhook' ? { k: 'webhook' }
        : path === 'owner-channel' ? { k: 'owner-channel-dm', channel: 'fixture' } : { k: 'owner-typed' };
      d.installProvenanceReader({ turnGenerationFor: () => 'g',
        provenance: () => ({ generation: 'g', threadId: 't', botId: 'b', principal: 'owner', roomOwnerOnly: true, at: 1, initiator }),
        live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: 'owner', owner: true,
          level: botPermissionMode(actor), ...(path === 'routine' ? { routine: { owner: true, sourceRunId: 'run', sourceBotId: 'b', recipientGeneration: 'g' } } : {}) }) });
      try {
        expect.soft(botPermissionMode(actor)).toBe('unlimited');
        for (const command of commands) {
          const verdict = path === 'routine'
            ? routineTurnApproval({ bot, run: { permissionMode: 'auto', permissionExplicit: false }, tool: 'Bash', summary: command, context: { ...context, commandText: command } }).verdict
            : autoVerdict(bot, 'Bash', command, { ...context, commandText: command });
          expect.soft(verdict.approve, `${path}: ${command}`).toBeTruthy();
          const h = f.open(command, { command });
          expect.soft(d.decide(h, () => verdict).kind, command).toBe('run');
          await d.deliverRequest(h);
        }
        expect.soft(d.openApprovals('t')).toHaveLength(0);
        expect.soft(f.respond).toHaveBeenCalledTimes(commands.length);
        const wipe = d.decide(f.open('wipe', { command: 'rm -rf ~' }), baseCard);
        expect(wipe.kind).toBe('card');
        if (wipe.kind === 'card') {
          await d.presentApproval(wipe.ref, { title: 'Wipe check', subtitle: 'Inert fixture input' });
          expect(d.readApproval(wipe.ref.approvalId)?.why).toBe('wipe');
        }
      } finally { f.dispose(); }
    });
  }
}
it('G-NL an explicit lower bot and a guest audience keep their cards', () => {
  restore = installPermissionInheritance(() => true);
  expect(autoVerdict({ autoApprove: false, permissionExplicit: true }, 'Bash', 'touch notes.txt', { noLimitsOrigin: 'webhook' }).approve).toBeNull();
  expect(autoVerdict(unlimited, 'Bash', 'touch notes.txt', { noLimitsOrigin: 'guest' }).approve).toBeNull();
});

it('G-NL scheduled routine origin retains No limits without a second origin field',()=>{
  const context:AutoContext={fullAccessOrigin:'routine',routineLevel:true,automated:true,unattended:true};
  expect(autoVerdict({...unlimited,permissionExplicit:true},'Bash','cat .env',context).approve).toBeTruthy();
  expect(autoVerdict({...unlimited,permissionExplicit:true},'Bash','rm -rf ~',{...context,commandText:'rm -rf ~'}).approve).toBeNull();
});

it.each(['routine','webhook'] as const)('G-NL legacy Full access without No limits keeps its lower trigger policy: %s',origin=>{
  restore=installPermissionInheritance(()=>false);
  const legacy={autoApprove:true,fullAccess:true,permissionRev:0};
  expect(permissionsForNoLimitsOrigin(origin,legacy)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});
});
