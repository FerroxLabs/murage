// SPDX-License-Identifier: AGPL-3.0-or-later
// Only bounded CDP pieces cross the native transport. A wide branch is paged in an isolated world.
import { NATIVE_CHILDREN_SOURCE } from "./browser-native-dom.ts";
import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;
type Send = (method: string, params?: Json) => Promise<any>;
const PAGE_SIZE = 64;
const EDITABLE_NODES = new Set(["INPUT", "TEXTAREA", "SELECT", "IFRAME", "FRAME", "OBJECT", "EMBED"]);
function editable(node: any) {
  if (EDITABLE_NODES.has(String(node?.nodeName ?? "").toUpperCase())) return true;
  const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    const name = String(attributes[i]).toLowerCase(), value = String(attributes[i + 1]);
    if (name === "contenteditable" && value.toLowerCase() !== "false") return true;
    if (name === "role" && /textbox|searchbox|combobox/i.test(value)) return true;
  }
  return false;
}
const presence = (node: any, id?: number) => Number.isSafeInteger(id) && node?.backendNodeId === id && node?.localName === "murage-presence" && Array.isArray(node.attributes) && node.attributes.includes("data-murage-presence");
const incomplete = (node: any) => {
  if (!node || typeof node !== "object" || Array.isArray(node) || !Object.keys(node).length || (node.children !== undefined && !Array.isArray(node.children))) throw Error("The browser DOM inspection returned an invalid branch.");
  const count = node.childNodeCount === undefined ? node.children?.length ?? 0 : node.childNodeCount;
  if (!Number.isSafeInteger(count) || count < (node.children?.length ?? 0)) throw Error("The browser DOM inspection returned an invalid child count.");
  return count > (node.children?.length ?? 0);
};

// Captured in the isolated world. Node covers elements, documents and shadow roots; neither
// named form controls nor custom element getters participate in reading this native list.
const CHILD_PAGER = `function() {
  const root = this;
  const page = (${NATIVE_CHILDREN_SOURCE})();
  return function(offset, count) { return page(root, offset, count); };
}`;

export async function inspectClosedRoots(send: Send, world: () => Promise<number>, presenceHost: () => Promise<number | undefined>): Promise<boolean> {
  const group = `murage-dom-inspection-${randomUUID()}`;
  let hasObjects = false, presenceRead = false, realHost: number | undefined;
  // Depth limits also cover long text descendants. Size rejection narrows the piece, never the verdict.
  async function describe(method: string, params: Json = {}) {
    for (const depth of [4, 2, 1, 0]) {
      try {
        const result = await send(method, { ...params, depth, pierce: true, murageInspection: true });
        const node = method === "DOM.getDocument" ? result?.root : result?.node;
        if (!node) throw Error("The browser DOM inspection returned no node.");
        return node;
      } catch (error) {
        if ((error as { code?: string }).code !== "response_too_large" || depth === 0) throw error;
      }
    }
  }
  // Include every native child in the count, even text. Only bounded handles cross the wire.
  async function* childPages(node: any): AsyncGenerator<any> {
    if (!Number.isSafeInteger(node.backendNodeId)) throw Error("The browser DOM inspection lost a node.");
    hasObjects = true;
    const resolved = await send("DOM.resolveNode", { backendNodeId: node.backendNodeId, executionContextId: await world(), objectGroup: group });
    const objectId = resolved?.object?.objectId;
    if (!objectId) throw Error("The browser DOM inspection could not resolve a branch.");
    let pagerId: string | undefined;
    try {
      const pager = await send("Runtime.callFunctionOn", { objectId, objectGroup: group, returnByValue: false, functionDeclaration: CHILD_PAGER });
      if (pager.exceptionDetails || !pager.result?.objectId) throw Error("The browser DOM inspection could not capture its node accessors.");
      pagerId = pager.result.objectId;
      let expected: number | undefined;
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await send("Runtime.callFunctionOn", {
          objectId: pagerId, objectGroup: group, returnByValue: false,
          functionDeclaration: "function(offset, count) { return this(offset, count); }",
          arguments: [{ value: offset }, { value: PAGE_SIZE }],
        });
        if (page.exceptionDetails || !page.result?.objectId) throw Error("The browser DOM inspection could not read a branch.");
        const arrayId = page.result.objectId;
        try {
          const properties = await send("Runtime.getProperties", { objectId: arrayId, ownProperties: true });
          if (properties.exceptionDetails || !Array.isArray(properties.result)) throw Error("The browser DOM inspection could not read its node handles.");
          const count = properties.result.find((p: any) => p.name === "length")?.value?.value;
          const total = properties.result.find((p: any) => p.name === "total")?.value?.value;
          // CDP may omit whitespace or already projected branches. The native count must cover
          // that frontier, stay stable across slices, and account for every inspected child.
          if (!Number.isSafeInteger(total) || total < (node.childNodeCount ?? 0) || (expected !== undefined && total !== expected)
            || !Number.isSafeInteger(count) || count !== Math.min(PAGE_SIZE, total - offset) || count <= 0) throw Error("The browser DOM inspection returned an incomplete batch.");
          expected = total;
          for (let i = 0; i < count; i++) {
            const childId = properties.result.find((p: any) => p.name === String(i))?.value?.objectId;
            if (!childId) throw Error("The browser DOM inspection lost a child.");
            const child = await describe("DOM.describeNode", { objectId: childId });
            await send("Runtime.releaseObject", { objectId: childId });
            yield child;
          }
          if (offset + count === expected) return;
        } finally { await send("Runtime.releaseObject", { objectId: arrayId }); }
      }
    } finally {
      if (pagerId) await send("Runtime.releaseObject", { objectId: pagerId });
      await send("Runtime.releaseObject", { objectId });
    }
  }
  type Piece = { node: any; vetted: boolean } | { iterator: AsyncGenerator<any>; vetted: boolean };
  const pending: Piece[] = [];
  const iterators = new Set<AsyncGenerator<any>>();
  const seen = new Set<number>();
  try {
    pending.push({ node: await describe("DOM.getDocument"), vetted: false });
    while (pending.length) {
      const piece = pending.pop()!;
      const vetted = piece.vetted;
      if ("iterator" in piece) {
        const next = await piece.iterator.next();
        if (!next.done) pending.push(piece, { node: next.value, vetted });
        else iterators.delete(piece.iterator);
        continue;
      }
      let node = piece.node;
      // A frontier node has no children in a shallow response. Expand just that branch.
      if (incomplete(node)) {
        if (!Number.isSafeInteger(node.backendNodeId)) throw Error("The browser DOM inspection lost a branch.");
        node = await describe("DOM.describeNode", { backendNodeId: node.backendNodeId });
      }
      incomplete(node);
      if (Number.isSafeInteger(node.backendNodeId)) {
        if (seen.has(node.backendNodeId)) throw Error("The page changed during DOM inspection.");
        seen.add(node.backendNodeId);
      }
      if (vetted && node.nodeType === 1 && editable(node)) return true;
      for (const root of node.shadowRoots ?? []) {
        if (root.shadowRootType === "closed") {
          if (!presenceRead) { realHost = await presenceHost(); presenceRead = true; }
          if (vetted || !presence(node, realHost)) return true;
          pending.push({ node: root, vetted: true });
        } else pending.push({ node: root, vetted });
      }
      if (node.contentDocument) pending.push({ node: node.contentDocument, vetted });
      if (incomplete(node)) {
        const iterator = childPages(node); iterators.add(iterator); pending.push({ iterator, vetted });
      } else for (const child of node.children ?? []) pending.push({ node: child, vetted });
    }
    return false;
  } finally {
    // Finish outstanding generators before releasing every handle, including on refusal or interruption.
    for (const iterator of iterators) await iterator.return(undefined).catch(() => {});
    if (hasObjects) await send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
  }
}
