import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryReview, candidateApproval, type MemoryCorrectionReview, type MemoryInspection } from "./MemoryReview";

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

describe("agent-proposed correction review", () => {
  const candidate = { ...inspection.record, id: "proposal", version: 1, text: "Deploys happen on Thursday", assertion: "assistant-inference" as const };
  const target = { id: "fact", version: 3, text: "Deploys happen on <b>Tuesday</b>", state: "active", ownerPinned: true, scopeId: "scope" };
  const review = (correction: MemoryCorrectionReview) => render({ ...inspection, record: candidate, correction });

  it("requires an explicit pin choice for a pinned target with nothing preselected", () => {
    const html = review({ status: "current", target });
    expect(html).toContain("Proposed correction");
    expect(html).toContain("Replaces version 3 of this memory:");
    expect(html).toContain("Deploys happen on &lt;b&gt;Tuesday&lt;/b&gt;");
    expect(html).toContain("The memory being replaced is pinned. Choose what happens to its pin:");
    expect(html).toContain("Pin the correction instead");
    expect(html).toContain("Leave the correction unpinned");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).not.toContain('checked=""');
    expect(html).toMatch(/disabled=""[^>]*>Approve correction/);
    expect(html).not.toContain("Approve candidate");
  });

  it("allows approval without a pin choice when the target is not pinned", () => {
    const html = review({ status: "current", target: { ...target, ownerPinned: false } });
    expect(html).not.toContain('type="radio"');
    expect(html).toContain("Approve correction");
    expect(html).not.toMatch(/disabled=""[^>]*>Approve correction/);
  });

  it.each([
    ["changed", "has changed since it was proposed"],
    ["unavailable", "is no longer available"],
  ] as const)("blocks approval when the target is %s", (status, notice) => {
    const html = review({ status, target: status === "changed" ? { ...target, state: "superseded" } : null });
    expect(html).toContain(notice);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('type="radio"');
    expect(html).toMatch(/disabled=""[^>]*>Approve correction/);
  });

  it("builds the approve request only from an explicit, still-valid choice", () => {
    expect(candidateApproval(candidate, null, "")).toEqual({ action: "approve", id: "proposal", version: 1 });
    expect(candidateApproval(candidate, { status: "current", target }, "")).toBeNull();
    expect(candidateApproval(candidate, { status: "current", target }, "transfer")).toEqual({ action: "approve", id: "proposal", version: 1, correctionPin: "transfer" });
    expect(candidateApproval(candidate, { status: "current", target }, "unpin")).toEqual({ action: "approve", id: "proposal", version: 1, correctionPin: "unpin" });
    expect(candidateApproval(candidate, { status: "current", target: { ...target, ownerPinned: false } }, "transfer")).toEqual({ action: "approve", id: "proposal", version: 1 });
    expect(candidateApproval(candidate, { status: "changed", target }, "transfer")).toBeNull();
    expect(candidateApproval(candidate, { status: "unavailable", target: null }, "unpin")).toBeNull();
    expect(candidateApproval({ ...candidate, state: "active" }, null, "")).toBeNull();
  });
});

it("offers reversible archival only for unpinned active records",()=>{
  const active={...inspection,record:{...inspection.record,state:"active" as const}};
  expect(render(active)).toContain("Archive memory");
  expect(render({...active,record:{...active.record,ownerPinned:true}})).not.toContain("Archive memory");
  expect(render({...active,record:{...active.record,state:"archived" as const}})).toContain("Restore to current recall");
});
