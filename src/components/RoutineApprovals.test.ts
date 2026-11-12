// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
vi.mock('@/state/store',()=>({api:vi.fn(),useStore:()=>({state:{instances:[]},dispatch:vi.fn()})}));
import {RoutineApprovalLevel,routineLevelChoice,routinePermissionPatch} from './RoutineApprovals';
it('F7 the editor follows by default and preserves an explicit lower owner choice',()=>{
 expect(routineLevelChoice()).toBe('inherit');
 expect(routineLevelChoice({permissionMode:'ask',permissionExplicit:false})).toBe('inherit');
 for(const permissionMode of ['ask','auto','full']as const)expect(routineLevelChoice({permissionMode,permissionExplicit:true})).toBe(permissionMode);
});
it('F7 the selector offers inheritance and describes wipe-only No limits',async()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 const host=document.createElement('div'),root=createRoot(host),onChange=vi.fn();
 try{
  await act(async()=>root.render(createElement(RoutineApprovalLevel,{value:'inherit',onChange,botName:'Fixture',botMode:'unlimited'})));
  const select=host.querySelector('select')!;expect(select.value).toBe('inherit');expect(host.textContent).toContain('Follow bot');
  expect(host.textContent).toContain('Only wipes and catastrophes ask.');expect(host.textContent).not.toContain('Reading your keys always asks.');
  await act(async()=>{select.value='ask';select.dispatchEvent(new Event('change',{bubbles:true}));});expect(onChange).toHaveBeenCalledWith('ask');
 }finally{await act(async()=>root.unmount());}
});

it('F7 renaming preserves inherited fallback and explicit levels; only a changed selection rewrites permission',()=>{
 const inherited={permissionMode:'ask' as const,permissionExplicit:false};
 expect(routinePermissionPatch('inherit',inherited)).toEqual({});
 expect(routinePermissionPatch('ask',{permissionMode:'ask',permissionExplicit:true})).toEqual({});
 expect(routinePermissionPatch('auto',inherited)).toEqual({permissionMode:'auto'});
 expect(routinePermissionPatch('inherit',{permissionMode:'ask',permissionExplicit:true})).toEqual({permissionMode:'inherit'});
 expect(routinePermissionPatch('inherit')).toEqual({permissionMode:'inherit'});
});
