// SPDX-License-Identifier: AGPL-3.0-or-later
// Prototype descriptors for the small DOM fixtures. Explicit backing data lets tests
// override page properties without changing what the simulated native accessor sees.
export const nativeBacking = new WeakMap<object, Record<string, any>>();
const read = (node: any, key: string, fallback: () => any) => {
  const data = nativeBacking.get(node);
  if (data && key in data) { if (data[key] instanceof Error) throw data[key]; return data[key]; }
  return fallback();
};
class NativeList {
  readonly values: any[];
  constructor(values: any[]) { this.values = values; }
  get length() { return this.values.length; }
  item(i: number) { return this.values[i] ?? null; }
}
class NativeNode {
  get baseURI(): any { return (this as any).baseURI ?? 'https://fixture.test/'; }
  get textContent(): any { return read(this, 'textContent', () => (this as any).textContent ?? ''); }
  get nodeType(): any { return read(this, 'nodeType', () => (this as any).nodeType); }
  get childNodes(): any { return read(this, 'childNodes', () => new NativeList([...new Set([...(this as any).childNodes ?? [], ...(this as any).children ?? []])])); }
  get parentNode(): any { return read(this, 'parentNode', () => (this as any).parentNode ?? null); }
  contains(other: any): boolean { if ((this as any).contains) return (this as any).contains(other); for(let n=other;n;n=n.parentNode) if(n===this)return true; return false; }
  getRootNode(): any { let n: any = this; while (n.parentNode) n = n.parentNode; return n; }
}
class NativeElement {
  getBoundingClientRect(): any { return read(this, 'getBoundingClientRect', () => (this as any).getBoundingClientRect).call(this); }
  get documentElement(): any { return (this as any).documentElement; }
  get ariaLabelledByElements(): any { return (this as any).ariaLabelledByElements ?? null; }
  get ariaDescribedByElements(): any { return (this as any).ariaDescribedByElements ?? null; }
  get ariaOwnsElements(): any { return (this as any).ariaOwnsElements ?? null; }
  getAttribute(key: string): any { return read(this, 'getAttribute', () => (this as any).attrs ? (this as any).attrs[key] ?? null : (this as any).getAttribute?.(key) ?? null); }
  get localName(): any { return read(this, 'localName', () => (this as any).localName ?? (this as any).tagName?.toLowerCase()); }
  closest(sel: string): any { return (this as any).closest?.(sel) ?? null; }
  matches(sel: string): any { return (this as any).matches?.(sel) ?? false; }
  get assignedSlot(): any { return (this as any).assignedSlot ?? null; }
  getElementById(id: string): any { return (this as any).getElementById?.(id) ?? null; }
  get shadowRoot(): any { return read(this, 'shadowRoot', () => (this as any).shadowRoot?.nodeType === 11 ? (this as any).shadowRoot : null); }
  querySelectorAll(sel: string): any { const query = read(this, 'querySelectorAll', () => Object.getOwnPropertyDescriptor(this, 'querySelectorAll')?.value); if (query) return new NativeList(query.call(this, sel));
    const nodes: any[] = [];
    const walk = (n: any) => {
      const children = Object.getOwnPropertyDescriptor(NativeNode.prototype, 'childNodes')!.get!.call(n);
      const total=children.length;
      for(let i=0;i<total;i++) { const child=children.item(i); if(!child)throw Error('Missing native child');
        if(Object.getOwnPropertyDescriptor(NativeNode.prototype, 'nodeType')!.get!.call(child)===1){nodes.push(child);walk(child);}
      }
      if(children.length!==total)throw Error('Changed native child count');
    };
    if ((this as any).body) { nodes.push((this as any).body); walk((this as any).body); } else walk(this);
    return new NativeList(nodes.filter(n => sel === '*' || sel.split(',').some(s => s.startsWith('[') ? NativeElement.prototype.getAttribute.call(n, s.slice(1, -1)) !== null : Object.getOwnPropertyDescriptor(NativeElement.prototype, 'localName')!.get!.call(n) === s)));
   }
}
class NativeControl {
  get checked(): any { return read(this, 'checked', () => (this as any).checked ?? false); }
  get value(): any { return read(this, 'value', () => (this as any).value ?? ''); }
  get selectedOptions(): any { return read(this, 'selectedOptions', () => new NativeList((this as any).selectedOptions ?? [])); }
  get form(): any { return (this as any).form ?? null; }
  get labels(): any { return new NativeList((this as any).labels ?? []); }
}
class NativeForm {
  get action(): any { return read(this, 'action', () => (this as any).action ?? ''); }
  get method(): any { return read(this, 'method', () => (this as any).method ?? 'get'); }
  get enctype(): any { return read(this, 'enctype', () => (this as any).enctype ?? ''); }
  get target(): any { return read(this, 'target', () => (this as any).target ?? ''); }
  get elements(): any { return read(this, 'elements', () => new NativeList((this as any).elements ?? [])); }
}
class NativeShadow { get host(): any { return (this as any).host ?? null; } }
class NativeSlot { assignedNodes(): any { return (this as any).assignedNodes?.() ?? []; } }
export const nativeRealm = { HTMLOptionElement: NativeControl, HTMLInputElement: NativeControl, HTMLButtonElement: NativeControl, HTMLSelectElement: NativeControl, HTMLTextAreaElement: NativeControl, HTMLFieldSetElement: NativeControl, HTMLOutputElement: NativeControl, HTMLObjectElement: NativeControl, Node: NativeNode, NodeList: NativeList, HTMLCollection: NativeList, Element: NativeElement,
  Document: NativeElement, DocumentFragment: NativeElement, HTMLFormElement: NativeForm, ShadowRoot: NativeShadow, HTMLSlotElement: NativeSlot };
export const nativeList = (values: any[]) => new NativeList(values);
export function domFunction(...args: string[]): Function {
  return new Function(...Object.keys(nativeRealm), ...args).bind(null, ...Object.values(nativeRealm));
}
