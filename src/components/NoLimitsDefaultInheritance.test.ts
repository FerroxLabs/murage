// SPDX-License-Identifier: AGPL-3.0-or-later
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import * as modes from '../lib/permission-mode';
import {LevelExamples} from './approval/LevelExamples';
import {t} from '../lib/i18n';
import {BotPermissionDefault,NO_LIMITS_TERMS_NOTE} from './BotPermissionDefault';
type Profile=Parameters<typeof BotPermissionDefault>[0]['bot'] & {permissionExplicit?:boolean;permissionRev?:number;draftOnly?:boolean};
const chief={chiefOfStaff:true,chiefScope:'workspace' as const,autoApprove:true,fullAccess:true,noLimits:true};
const effective=(bot:Profile,bots=[chief],level?:string)=>modes.ownerBotPermissions(bot,bots,level);
const selected=(bot:Profile)=>{
 const html=renderToStaticMarkup(createElement(BotPermissionDefault,{bot,onThisComputer:false,desktop:true,onChoose:()=>{},onOption:()=>{}}));
 return [...html.matchAll(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*>([^<]*)</g)].map(match=>match[1]);
};
for(const [name,bot,label]of [
 ['old Ask',{autoApprove:false},'No limits'],
 ['old Auto',{autoApprove:true,fullAccess:false},'No limits'],
 ['explicit Ask',{autoApprove:false,permissionExplicit:true},'Ask'],
 ['explicit Auto',{autoApprove:true,permissionExplicit:true},'Auto'],
 ['legacy Full',{autoApprove:true,fullAccess:true},'No limits'],
 ['revised Ask',{autoApprove:false,permissionRev:2},'Ask'],
 ['reset to inherit',{autoApprove:false,permissionExplicit:false,permissionRev:2},'No limits'],
 ['draft',{autoApprove:false,draftOnly:true},'Ask'],
 ['draft with stored No limits',{autoApprove:true,fullAccess:true,noLimits:true,draftOnly:true},'Ask'],
]as const)it(`R3 F7 Settings shows ${name} as ${label}`,()=>{
 const original={...bot};expect(selected(effective(bot,[chief],'auto'))).toEqual([label]);expect(bot).toEqual(original);
});
it('R3 F7 the owner can choose Ask below the inherited displayed level',()=>{
 const bot=effective({autoApprove:false,permissionExplicit:false});
 expect(modes.permissionModeOf(bot)).toBe('unlimited');
 expect(modes.permissionModeOf(bot)).not.toBe('ask'); // useLevelChange must not take its same-level no-op.
 expect(modes.needsLevelConfirm(modes.permissionModeOf(bot),'ask')).toBe(false);
});
it('R3 F7 the new-bot No limits choice also resolves the Settings level',()=>{
 expect(selected(effective({autoApprove:false},[],'no-limits'))).toEqual(['No limits']);
 expect(selected(effective({autoApprove:false},[],'auto'))).toEqual(['Ask']);
});
it('R3 F7 Settings routes the effective profile through both display and level changes',()=>{
 const source=readFileSync(new URL('./SettingsPanel.tsx',import.meta.url),'utf8');
 expect(source).toMatch(/const permissionBot\s*=\s*ownerBotPermissions\(bot, state.bots, state.config\?\.newBots\?\.permissionLevel\)/);
 expect(source).toContain('useLevelChange({ bot: permissionBot,');expect(source).toContain('permissionModeOf(permissionBot)');expect(source).toMatch(/bot=\{permissionBot\}\s+change=\{levelChange\}/);
});
it('R3-4 the stale terms notice does not claim a per-call No limits hold',()=>{
 expect(NO_LIMITS_TERMS_NOTE).not.toMatch(/keeps asking|until you accept/);
});

const exampleRow=(level:'ask'|'unlimited',id:string)=>renderToStaticMarkup(createElement(LevelExamples,{only:level})).match(new RegExp('<tr[^>]*data-level-other="'+id+'"[\\s\\S]*?</tr>'))?.[0]??'';
it('R3 the No limits example shows webhook actions running',()=>{
 const row=exampleRow('unlimited','other-channel-or-webhook');
 expect(row.split(t('ux.l1.level.goesAhead')).length-1).toBe(2);
 expect(row).not.toContain('ux.l1.level.cell.goes-ahead');
});
it('R3 the No limits routine example removes the payment prohibition',()=>{
 const row=exampleRow('unlimited','routine');
 // MAIN RULING SEAN 11-12 / 11-14 inherited No limits: explicit lower routine ceilings still apply.
 expect(row.replace(/&#x27;/g, "'")).toContain(t('ux.l1.level.cell.lower-of-ceiling')); // Compare rendered words after HTML escaping.
 expect(row).not.toContain(t('ux.l1.level.note.never-for-payment'));
});
it('R3 the Ask routine example preserves the grant and payment limits',()=>{
 const row=exampleRow('ask','routine');
 expect(row).toContain(t('ux.l1.level.cell.asks-unless-routine-grant'));
 expect(row).toContain(t('ux.l1.level.note.never-for-payment'));
});

it('G-NL Settings plainly names inherited routine and webhook behavior',()=>{
 const html=renderToStaticMarkup(createElement(BotPermissionDefault,{bot:chief,onThisComputer:false,desktop:true,onChoose:()=>{},onOption:()=>{}}));
 expect(html).toContain('its routines and webhooks run at No limits');
 expect(html).toContain('Only the wipe check can ask.');
});

it('G-NL No limits options do not promise extra key or setup approval cards',()=>{
 const html=renderToStaticMarkup(createElement(BotPermissionDefault,{bot:chief,onThisComputer:false,desktop:true,onChoose:()=>{},onOption:()=>{}}));
 expect(html).not.toContain('Reading keys still asks.');
 expect(html).toContain(t('ux.l1.level.setupIncluded'));
 expect(html).toContain(t('ux.l1.level.cell.channel-enabled'));
 const setup=html.match(/<button[^>]*aria-label="Setup requests"[^>]*>/)?.[0]??'';
 expect(setup).toContain('aria-checked="true"');
 expect(setup).toContain('disabled=""');
});
