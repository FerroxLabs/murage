// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterEach, expect, it, vi } from "vitest";
const harness=vi.hoisted(()=>({effect:null as null|(()=>void|(()=>void))}));
vi.mock("react",async original=>({...await original<typeof import("react")>(),useRef:(current:unknown)=>({current}),useId:()=>"heading",useEffect:(effect:()=>void|(()=>void))=>{harness.effect=effect;}}));
import { ProjectBoardDialog } from "./ProjectBoardDialog";
afterEach(()=>vi.unstubAllGlobals());
it.each(["New project","Close project","End project"])("F1 %s returns focus to its explicit opener after Escape and Close",title=>{
  for(const action of ["escape","close"]){
    const prior={isConnected:false,focus:vi.fn(),closest:()=>null},opener={isConnected:true,focus:vi.fn(),closest:()=>null};vi.stubGlobal("document",{activeElement:prior});
    const onClose=vi.fn();const tree=ProjectBoardDialog({title,children:null,onClose,returnFocusRef:{current:opener as unknown as HTMLElement}});
    const modal={showModal:vi.fn(),close:vi.fn()};tree.props.ref.current=modal;const cleanup=harness.effect!();
    if(action==="escape")tree.props.onCancel({preventDefault:vi.fn()});else tree.props.children[0].props.children[1].props.onClick();
    expect(onClose).toHaveBeenCalledOnce();tree.props.ref.current=null;if(typeof cleanup==="function")cleanup();
    expect(modal.close).toHaveBeenCalledOnce();expect(opener.focus).toHaveBeenCalledOnce();expect(prior.focus).not.toHaveBeenCalled();
  }
});
it("F1 preserves connected prior focus for other board dialogs",()=>{
  const prior={isConnected:true,focus:vi.fn(),closest:()=>null};vi.stubGlobal("document",{activeElement:prior});
  ProjectBoardDialog({title:"Card",children:null,onClose:vi.fn()});const cleanup=harness.effect!();if(typeof cleanup==="function")cleanup();expect(prior.focus).toHaveBeenCalledOnce();
});
