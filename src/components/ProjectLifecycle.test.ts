// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
vi.mock("react",async original=>({...await original<typeof import("react")>(),useState:(v:unknown)=>[v,()=>{}]}));
vi.mock("@/lib/use-project",()=>({projectClient:{close:vi.fn(async()=>({ok:true})),end:vi.fn(async()=>({ok:true}))},refreshProject:vi.fn()}));
import CloseProjectDialog from "./CloseProjectDialog";
import EndProjectDialog from "./EndProjectDialog";
import { projectClient } from "@/lib/use-project";
function nodes(n:unknown):ReactElement<Record<string,any>>[]{ if(!n||typeof n!=="object")return []; if(Array.isArray(n))return n.flatMap(nodes);const e=n as ReactElement<Record<string,any>>;return[e,...nodes(e.props?.children)]; }
it("requires the explicit stop-and-close button for paused goals",async()=>{
  const tree=nodes(CloseProjectDialog({groupId:"g",goalState:"paused",onClose:vi.fn()}));
  const button=tree.find(n=>n.type==="button"&&n.props.children==="Stop the goal and close")!;
  expect(button).toBeDefined(); await button.props.onClick();
  expect(projectClient.close).toHaveBeenCalledWith("g",true);
});
it("refuses active work in the close dialog",()=>{
  const tree=nodes(CloseProjectDialog({groupId:"g",goalState:"working",onClose:vi.fn()}));
  expect(tree.find(n=>n.type==="button"&&n.props.children==="Close project")?.props.disabled).toBe(true);
});
it("explains End and only sends it from the confirmation",async()=>{
  const tree=nodes(EndProjectDialog({groupId:"g",onClose:vi.fn()}));
  expect(projectClient.end).not.toHaveBeenCalled();
  expect(JSON.stringify(tree)).toContain("History stays readable");
  await tree.find(n=>n.type==="button"&&n.props.children==="End project")!.props.onClick();
  expect(projectClient.end).toHaveBeenCalledWith("g");
});
it("keeps all three dialogs behind retryable lazy boundaries",()=>{
  const sidebar=readFileSync(new URL("./Sidebar.tsx",import.meta.url),"utf8");
  const group=readFileSync(new URL("./GroupView.tsx",import.meta.url),"utf8");
  expect(sidebar).toContain('retryableLazy(() => import("./NewProjectDialog"))');
  for(const name of ["CloseProjectDialog","EndProjectDialog"])expect(group).toContain(`retryableLazy(() => import("./${name}"))`);
  expect(group).toContain("ProjectLifecycleBanner"); expect(group).toContain("Reopen");
});

it('C11 closing banner names the lead and offers no lifecycle writes', async () => {
  const {ProjectLifecycleBanner}=await import('./ProjectLifecycleBanner');
  const tree=nodes(ProjectLifecycleBanner({closing:true,closed:false,leadName:'Finch',onReopen:vi.fn(),reopening:false}));
  expect(JSON.stringify(tree)).toContain("Closing: waiting for Finch's summary");
  expect(tree.filter(n=>n.type==='button')).toHaveLength(0);
  expect(JSON.stringify(nodes(ProjectLifecycleBanner({closing:true,closed:false,reopening:false})))).toContain('Closing');
});
