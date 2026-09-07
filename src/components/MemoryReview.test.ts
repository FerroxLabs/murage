import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MemoryReview, type MemoryInspection } from "./MemoryReview";

const inspection: MemoryInspection = {
  record: { id: "record", version: 2, scopeId: "scope", kind: "fact", text: "<script>untrusted</script>", assertion: "unverified-import", state: "candidate", ownerPinned: false, validFrom: 1, validTo: null },
  evidence: [{ sourceId: "source", revision: 1, startByte: 0, endByte: 8, text: "<img src=x onerror=alert(1)>", hash: "hash", speaker: "assistant" }], lineage: [],
};
const render = (value = inspection, busy = false) => renderToStaticMarkup(createElement(MemoryReview, { inspection: value, audiences: [{ id: "scope", kind: "bot", ownerKey: "bot", label: "Private bot" }], busy, onAction: async () => {}, onClose: () => {} }));
it("renders imported memory and source content as text and keeps approval explicit", () => {
  const html = render();
  expect(html).toContain("&lt;script&gt;untrusted&lt;/script&gt;");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Approve candidate");
  expect(html).not.toContain("Save correction");
  expect(html).not.toContain("Review as skill");
  expect(html).toContain("Confirm forgetting this memory");
  expect(html).toMatch(/disabled=""[^>]*>Forget memory/);
});
it("shows owner corrections for active memory and disables mutations while pending", () => {
  const html = render({ ...inspection, record: { ...inspection.record, state: "active", assertion: "owner-statement" } }, true);
  expect(html).toContain("Correction text");
  expect(html).toContain("Save correction");
  expect(html).toContain("Share with audience");
  expect(html).toContain("Review as skill");
  expect(html).toContain("Bot to review this skill");
  expect(html).toContain("no skill is activated by this action");
  expect(html).toContain('<fieldset disabled=""');
});

it("offers reversible archival only for unpinned active records",()=>{
  const active={...inspection,record:{...inspection.record,state:"active" as const}};
  expect(render(active)).toContain("Archive memory");
  expect(render({...active,record:{...active.record,ownerPinned:true}})).not.toContain("Archive memory");
  expect(render({...active,record:{...active.record,state:"archived" as const}})).toContain("Restore to current recall");
});
