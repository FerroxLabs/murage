import {noLimitsAppliesTo} from '../no-limits-origin.ts';
import {noLimitsInitiator} from '../auto-approve.ts';
// Sean 2026-11-12: independently describe the changed cells of the immutable
// r13b fixture. Every lower-level and unproven byte remains compared verbatim.
import {expect} from 'vitest';
import {WIPE_RULES} from './no-limits-1019.ts';
export function expectRulingForPinnedRow(row:any,actual:{approve:string|null;rule?:string}):boolean {
 const initiator=noLimitsInitiator(row.bot,row.context);
 const origin=row.context?.noLimitsOrigin ?? (initiator==='routine' && row.context?.unattended!==true ? 'owner-routine' : initiator);
 if(origin!=='owner' && origin!=='owner-channel' && origin!=='owner-routine')return false;
 if(!noLimitsAppliesTo(origin,row.bot))return false;
 const wipe=WIPE_RULES.has(row.expected.rule);
 expect(actual.approve===null,row.id).toBe(wipe);
 if(wipe)expect(actual.rule,row.id).toBe(row.expected.rule);
 return true;
}

/** Explicit reviewed deltas to the immutable R13 fixture. No expected value
 * comes from the observed verdict; unlisted rows retain their exact bytes. */
export function pinnedBaseRulingExpected(row: {id:string;expected:Record<string,unknown>}): Record<string,unknown> {
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 70e2850380: a configured routine level without stored provenance cannot grant No limits.
 if (new Set(['routineKnownCwd-108','routine-156','routineKnownCwd-whitespace-336','routineKnownCwd-whitespace-337','routine-whitespace-360','routine-whitespace-361']).has(row.id)) return {approve:null,source:'no-grant'};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 70e2850380: these formerly granted unproven routine deletes now retain the exact destructive hold.
 if (new Set(['routineKnownCwd-109','routineKnownCwd-110','routine-158']).has(row.id)) return {approve:null,source:'destructive-guard',rule:String.raw`\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]`};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 70e2850380 77f5566081: preserve every held unreadable byte and assert the newly exposed tokenizer diagnostic.
 if (new Set(['routineKnownCwd-111','routineStop-135','routine-159']).has(row.id)) return {...row.expected,reason:'tokenizer'};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 70e2850380 77f5566081: preserve the stricter original unreadable card, including its copy and reader, plus the value-path diagnostic.
 if (new Set(['routineStop-133','routine-157']).has(row.id)) return {...row.expected,reason:'value-path'};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 70e2850380 77f5566081: catastrophe cards, source, rule and copy remain byte exact; add only their diagnostic reason.
 if (new Set(['routineKnownCwd-112','routineStop-136','routine-160','routineKnownCwd-whitespace-338','routineStop-whitespace-350','routine-whitespace-362']).has(row.id)) return {...row.expected,reason:'delete-root'};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 77f5566081: held tokenizer diagnostic is explicit.
 if (new Set(['delegatedOwnerOrigin-3','delegatedOwnerOrigin-9','delegatedOwnerOrigin-15','manualRoutine-27','manualRoutine-33','manualRoutine-39','scheduledRoutine-51','scheduledRoutine-57','scheduledRoutine-63','ownerLowerLevels-75','ownerLowerLevels-81','ownerLowerLevels-87','routineKnownCwd-93','routineKnownCwd-99','routineKnownCwd-105','routineStop-117','routineStop-123','routineStop-129','routine-141','routine-147','routine-153','channel-165','channel-171','channel-177','webhook-189','webhook-195','webhook-201','webhook-207','delegated-213','delegated-219','delegated-225','delegated-231','other-237','other-243','other-249','other-255','unproven-261','unproven-267','unproven-273','unproven-279']).has(row.id)) return {...row.expected,reason:'tokenizer'};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 77f5566081: held wipe diagnostic is explicit.
 if (new Set(['delegatedOwnerOrigin-4','delegatedOwnerOrigin-10','delegatedOwnerOrigin-16','manualRoutine-28','manualRoutine-34','manualRoutine-40','scheduledRoutine-52','scheduledRoutine-58','scheduledRoutine-64','ownerLowerLevels-76','ownerLowerLevels-82','ownerLowerLevels-88','routineKnownCwd-94','routineKnownCwd-100','routineKnownCwd-106','routineStop-118','routineStop-124','routineStop-130','routine-142','routine-148','routine-154','channel-166','channel-172','channel-178','webhook-190','webhook-196','webhook-202','webhook-208','delegated-214','delegated-220','delegated-226','delegated-232','other-238','other-244','other-250','other-256','unproven-262','unproven-268','unproven-274','unproven-280','delegatedOwnerOrigin-whitespace-284','delegatedOwnerOrigin-whitespace-287','delegatedOwnerOrigin-whitespace-290','manualRoutine-whitespace-296','manualRoutine-whitespace-299','manualRoutine-whitespace-302','scheduledRoutine-whitespace-308','scheduledRoutine-whitespace-311','scheduledRoutine-whitespace-314','ownerLowerLevels-whitespace-320','ownerLowerLevels-whitespace-323','ownerLowerLevels-whitespace-326','routineKnownCwd-whitespace-329','routineKnownCwd-whitespace-332','routineKnownCwd-whitespace-335','routineStop-whitespace-341','routineStop-whitespace-344','routineStop-whitespace-347','routine-whitespace-353','routine-whitespace-356','routine-whitespace-359','channel-whitespace-365','channel-whitespace-368','channel-whitespace-371','webhook-whitespace-377','webhook-whitespace-380','webhook-whitespace-383','webhook-whitespace-386','delegated-whitespace-389','delegated-whitespace-392','delegated-whitespace-395','delegated-whitespace-398','other-whitespace-401','other-whitespace-404','other-whitespace-407','other-whitespace-410','unproven-whitespace-413','unproven-whitespace-416','unproven-whitespace-419','unproven-whitespace-422']).has(row.id)) return {...row.expected,reason:'delete-root'};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 77f5566081: unattended denial is projected to no-grant.
 if (new Set(['webhook-204','webhook-whitespace-384','webhook-whitespace-385']).has(row.id)) return {...row.expected,source:'no-grant'};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 77f5566081: the live lower ceiling uses its destructive guard.
 if (new Set(['webhook-205','delegated-229','other-253','unproven-277']).has(row.id)) return {approve:null,source:'destructive-guard',rule:String.raw`\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]`};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 77f5566081: unproven delegated actors cannot use the bot auto grant.
 if (new Set(['delegated-228','other-252','delegated-whitespace-396','delegated-whitespace-397','other-whitespace-408','other-whitespace-409']).has(row.id)) return {approve:null,source:'no-grant'};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 77f5566081: unproven actors cannot use No limits.
 if (new Set(['unproven-276','unproven-whitespace-420','unproven-whitespace-421']).has(row.id)) return {approve:null,source:'no-grant'};
 // MAIN RULING INT-CONFLICT-DEFAULT dd8141d4ed 77f5566081: unproven destructive requests remain held.
 if (new Set(['unproven-278']).has(row.id)) return {approve:null,source:'destructive-guard',rule:String.raw`\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]`};
 return row.expected;
}
