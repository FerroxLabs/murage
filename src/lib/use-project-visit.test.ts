// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import {createElement,type EffectCallback} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach,expect,it,vi} from "vitest";
import {useProjectVisit} from "./use-project-visit";
import {projectClient} from "./use-project";
const fixture=vi.hoisted(()=>({effects:[] as EffectCallback[],set:vi.fn()}));
vi.mock("react",async original=>({...await original<typeof import("react")>(),useEffect:(fn:EffectCallback)=>fixture.effects.push(fn),useState:()=>[null,fixture.set]}));
vi.mock("./use-project",()=>({projectClient:{project:vi.fn(),viewed:vi.fn()}}));
afterEach(()=>{fixture.effects.length=0;vi.resetAllMocks();});
function Probe(){useProjectVisit("g",true);return null;}
it("each visit reads fresh counts before marking viewed, even after remount",async()=>{
 const counts={messages:9,cards:3,decisions:2};
 vi.mocked(projectClient.project).mockResolvedValue({ok:true,data:{sinceYouLeft:counts}} as never);
 for(let visit=1;visit<=2;visit++){
  renderToStaticMarkup(createElement(Probe));const stop=fixture.effects.at(-1)!();
  expect(projectClient.viewed).toHaveBeenCalledTimes(visit-1);
  await Promise.resolve();expect(fixture.set).toHaveBeenLastCalledWith(counts);expect(projectClient.viewed).toHaveBeenCalledTimes(visit);
  if(typeof stop==="function")stop();
 }
 expect(projectClient.project).toHaveBeenCalledTimes(2);
});
it("does not mark viewed after the visit has ended or a failed fresh read",async()=>{
 let finish!:(value:unknown)=>void;vi.mocked(projectClient.project).mockReturnValue(new Promise(resolve=>{finish=resolve;}) as never);
 renderToStaticMarkup(createElement(Probe));const stop=fixture.effects[0]();if(typeof stop==="function")stop();
 finish({ok:true,data:{sinceYouLeft:{messages:9,cards:0,decisions:0}}});await Promise.resolve();expect(projectClient.viewed).not.toHaveBeenCalled();
 vi.mocked(projectClient.project).mockResolvedValue({ok:false} as never);renderToStaticMarkup(createElement(Probe));fixture.effects.at(-1)!();await Promise.resolve();expect(projectClient.viewed).not.toHaveBeenCalled();
});
