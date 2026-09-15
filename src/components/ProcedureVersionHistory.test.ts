import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProcedureVersionHistory, SkillVersionHistory } from "./ProcedureVersionHistory";
it("keeps history as a labelled disclosure with explicit future-task consequences",()=>{
  const html=renderToStaticMarkup(createElement(ProcedureVersionHistory,{source:{load:vi.fn(),restore:vi.fn()},label:"Skill version history",scopeLabel:"Current task audience"}));
  expect(html).toContain("<details");expect(html).toContain('aria-label="Skill version history"');expect(html).toContain("Current task audience");expect(html).toContain("Running tasks keep their instruction version");expect(html).not.toContain("Confirm restore");
});
it("workspace history controls remain hidden on surfaces without desktop authority",()=>{
  expect(renderToStaticMarkup(createElement(SkillVersionHistory,{botId:"bot",name:"skill",threadId:"thread",canEdit:false}))).toBe("");
});
