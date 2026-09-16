import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProcedureEvaluationAdmissions } from "./ProcedureEvaluationAdmissions";
it("waiting reviews are selectable without granting access or showing unrelated instructions",()=>{
  const html=renderToStaticMarkup(createElement(ProcedureEvaluationAdmissions,{status:{max:32,reviews:[{id:"review",target:{kind:"skill",ownerId:"bot",artifactId:"checked-method",scopeId:"scope",threadId:"thread",baseRevision:"revision"},status:"pending",reason:null,started:false}]},onRefresh:vi.fn()}));
  expect(html).toContain('aria-label="Waiting procedure review"');expect(html).toContain("checked-method");expect(html).toContain("compatible test set remain waiting");expect(html).not.toContain("Allow this procedure evaluation");expect(html).not.toContain('type="checkbox"');
});
