import { expect, it } from 'vitest';
import { resolveCall, type GrantCall } from '../../shared/app-action-grant.ts';
import { autoVerdict } from '../auto-approve.ts';
import { requiredDriverFields, requiredFields } from './contracts.ts';

it('legacy summary calls retain their policy contract without inventing a driver', () => {
  expect(requiredFields(undefined, {kind:'unstamped'}, undefined)).toEqual({ok:true});
  expect(autoVerdict({autoApprove:true}, 'Read', 'Read ordinary notes').approve).toEqual(expect.any(String));
});

it('legacy structured calls keep the historical reader and the protected-path guard', () => {
  const call = {toolCall:{name:'edit',input:{file_path:'/w/proj/.ssh/config'}}};
  expect(requiredFields(undefined, resolveCall(call), call)).toEqual({ok:true});
  expect(autoVerdict({autoApprove:true}, 'edit', '/w/proj/.ssh/config', {call})).toMatchObject({approve:null,source:'sensitive-guard'});
});

it('an explicit driver envelope cannot become legacy when its engine value is missing', () => {
  const call = {engine:undefined,toolCall:{name:'edit',input:{newText:'new'}}};
  expect(requiredFields(undefined, resolveCall(call), call)).toEqual({ok:false,field:'engine'});
  expect(autoVerdict({autoApprove:true,fullAccess:true}, 'Edit', 'Edit notes', {fullAccessOrigin:'owner',call})).toMatchObject({approve:null,source:'unread-call'});
});

it.each(['claude','codex','pi','acp'] as const)('the legacy adapter still checks %s driver contracts', engine => {
  const call: GrantCall = {engine,toolKind:'edit',toolCall:{name:engine==='claude'?'Edit':'edit',input:{}}};
  expect(requiredFields(engine,resolveCall(call),call).ok).toBe(false);
});

it.each([undefined,{}, {toolKind:'edit'}, {inputMissing:'path'}] as const)('the strict driver reader never accepts missing metadata: %j', call => {
  expect(requiredDriverFields(undefined,{kind:'unstamped'},call)).toEqual({ok:false,field:'engine'});
});
