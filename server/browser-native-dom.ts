// SPDX-License-Identifier: AGPL-3.0-or-later
// Captured once per isolated-world invocation. Node covers documents and shadow
// roots as well as elements, so named controls never supply a child collection.
export const NATIVE_CHILDREN_SOURCE = String.raw`function(){
  const children=Object.getOwnPropertyDescriptor(Node.prototype,'childNodes').get;
  const length=Object.getOwnPropertyDescriptor(NodeList.prototype,'length').get;
  const {value:item}=Object.getOwnPropertyDescriptor(NodeList.prototype,'item');
  return function(root,offset=0,count=80000){
    const nodes=children.call(root),total=length.call(nodes),result=[],seen=new Set();
    if(!Number.isSafeInteger(total)||total<0)throw Error('Invalid native child count');
    for(let i=offset;i<Math.min(total,offset+count);i++){
      const node=item.call(nodes,i);
      if(!node||seen.has(node))throw Error('Incomplete native child list');
      seen.add(node);result.push(node);
    }
    if(length.call(nodes)!==total||result.length!==Math.max(0,Math.min(count,total-offset)))throw Error('Changed native child count');
    result.total=total;return result;
  };
}`;

export const NATIVE_DOM_SOURCE = String.raw`function(){
  const page=(${NATIVE_CHILDREN_SOURCE})();
  const getter=(p,k)=>Object.getOwnPropertyDescriptor(p,k).get;
  const method=(p,k)=>{const {value}=Object.getOwnPropertyDescriptor(p,k);return value;};
  const baseURI=getter(Node.prototype,'baseURI');
  const parent=getter(Node.prototype,'parentNode'),root=method(Node.prototype,'getRootNode'),type=getter(Node.prototype,'nodeType');
  const kind=n=>type.call(n);
  const attribute=method(Element.prototype,'getAttribute'),text=getter(Node.prototype,'textContent');
  const values={input:getter(HTMLInputElement.prototype,'value'),textarea:getter(HTMLTextAreaElement.prototype,'value'),select:getter(HTMLSelectElement.prototype,'value')};
  const checked=getter(HTMLInputElement.prototype,'checked'),documentElement=getter(Document.prototype,'documentElement');
  const selected=getter(HTMLSelectElement.prototype,'selectedOptions'),optionValue=getter(HTMLOptionElement.prototype,'value');
  const local=getter(Element.prototype,'localName'),closest=method(Element.prototype,'closest'),matches=method(Element.prototype,'matches'),contains=method(Node.prototype,'contains');
  const forms=Object.create(null),labels=Object.create(null),references=Object.create(null);
  for(const key of ['ariaLabelledByElements','ariaDescribedByElements','ariaOwnsElements']){
    const desc=Object.getOwnPropertyDescriptor(Element.prototype,key);if(desc)references[key]=desc.get;
  }
  for(const [tag,type] of [['input',HTMLInputElement],['button',HTMLButtonElement],['select',HTMLSelectElement],['textarea',HTMLTextAreaElement],['fieldset',HTMLFieldSetElement],['output',HTMLOutputElement],['object',HTMLObjectElement]]){
    forms[tag]=getter(type.prototype,'form');const desc=Object.getOwnPropertyDescriptor(type.prototype,'labels');if(desc)labels[tag]=desc.get;
  }
  const shadow=getter(Element.prototype,'shadowRoot'),host=getter(ShadowRoot.prototype,'host');
  const elements=getter(HTMLFormElement.prototype,'elements');
  const formProperties=Object.fromEntries(['action','method','enctype','target'].map(k=>[k,getter(HTMLFormElement.prototype,k)]));
  const nl=getter(NodeList.prototype,'length'),ni=method(NodeList.prototype,'item');
  const cl=getter(HTMLCollection.prototype,'length'),ci=method(HTMLCollection.prototype,'item');
  const eq=method(Element.prototype,'querySelectorAll'),dq=method(Document.prototype,'querySelectorAll'),fq=method(DocumentFragment.prototype,'querySelectorAll');
  const assigned=method(HTMLSlotElement.prototype,'assignedNodes'),slot=getter(Element.prototype,'assignedSlot');
  const di=method(Document.prototype,'getElementById'),fi=method(DocumentFragment.prototype,'getElementById');
  const list=(value,length,item,cap)=>{
    const total=length.call(value),out=[],seen=new Set();
    if(!Number.isSafeInteger(total)||total<0||total>cap)throw Error('Native collection exceeds inspection bound');
    for(let i=0;i<total;i++){const node=item.call(value,i);if(!node||seen.has(node))throw Error('Incomplete native collection');seen.add(node);out.push(node);}
    if(length.call(value)!==total||out.length!==total)throw Error('Changed native collection count');
    return out;
  };
  const nodes=(n,cap=80000)=>{const out=page(n,0,cap);if(out.length!==out.total)throw Error('Native children exceed inspection bound');return out;};
  const tag=n=>kind(n)===1?local.call(n):'';
  const attr=(n,k)=>kind(n)===1?attribute.call(n,k):null;
  const controlType=n=>{const t=tag(n);return (attr(n,'type')||(t==='input'?'text':t==='button'?'submit':'')).toLowerCase();};
  const fieldLike=n=>{
    const t=tag(n),role=(attr(n,'role')||'').toLowerCase(),ce=attr(n,'contenteditable');
    return t==='input'||t==='select'||t==='textarea'||t==='output'||t==='button'&&(attr(n,'name')!==null||attr(n,'value')!==null)||ce!==null&&ce.toLowerCase()!=='false'||['textbox','combobox','listbox','searchbox','spinbutton','option','checkbox','radio','switch','slider','menuitemcheckbox','menuitemradio','treeitem'].includes(role)||role==='gridcell'&&attr(n,'aria-selected')!==null;
  };
  const api={nodes,kind,tag,attr,formProperty:(n,k)=>formProperties[k].call(n),baseURI:n=>baseURI.call(n),controlType,checked:n=>checked.call(n),text:n=>text.call(n),fieldLike,
    value:n=>tag(n)==='option'?optionValue.call(n):values[tag(n)]?values[tag(n)].call(n):text.call(n),
    options:n=>list(selected.call(n),cl,ci,4000),
    references:(n,key,cap)=>{const get=references[key];if(!get)return [];const nodes=get.call(n);if(nodes==null)return [];if(!Array.isArray(nodes)||nodes.length>cap)throw Error('Incomplete native references');return nodes.slice();},
    selected:n=>list(selected.call(n),cl,ci,4000).map(o=>optionValue.call(o)),
    form:n=>forms[tag(n)]?forms[tag(n)].call(n):null,labels:n=>{const get=labels[tag(n)];if(!get)return [];const value=get.call(n);return value?list(value,nl,ni,4000):[];},
    closest:(n,s)=>closest.call(n,s),matches:(n,s)=>matches.call(n,s),contains:(n,c)=>contains.call(n,c),children:(n,cap)=>nodes(n,cap).filter(c=>kind(c)===1),
    parent:n=>n?(parent.call(n)||(kind(n)===11?host.call(n):null)):null,
    root:n=>root.call(n),slot:n=>kind(n)===1?slot.call(n):null,byId:(n,id)=>(kind(n)===11?fi:di).call(n,id),shadow:n=>kind(n)===1?shadow.call(n):null,
    elements:(n,cap=2000)=>list(elements.call(n),cl,ci,cap),
    query:(n,sel,cap=80000)=>list((kind(n)===9?dq:kind(n)===11?fq:eq).call(n,sel),nl,ni,cap),
    assigned:n=>assigned.call(n)};
  // One bounded inventory, rooted at documentElement, including all open roots.
  // Closed roots are handled by the inspector, including the presence exclusion.
  // Template content is an inert DocumentFragment, not a rendered descendant.
  // It enters this inventory only after the page inserts it into the document.
  // Frames are not recursively inventoried here; their presence prevents certainty.
  api.fieldPresence=document=>{
    const root=documentElement.call(document);
    if(!root)throw Error('Missing document element');
    const roots=[root],seen=new Set(roots),fields=[],all=[],unique=new Set();let incomplete=false;
    for(let i=0;i<roots.length;i++){
      if(roots.length>300)throw Error('Native root inventory exceeds inspection bound');
      const r=roots[i],entries=kind(r)===1?[r,...api.query(r,'*')]:api.query(r,'*');
      for(const e of entries){
        if(unique.has(e))throw Error('Duplicate native element');unique.add(e);all.push(e);
        if(all.length>80000)throw Error('Native element inventory exceeds inspection bound');
        if(fieldLike(e))fields.push(e);
        if(['iframe','frame','object','embed'].includes(tag(e)))incomplete=true;
        const sr=shadow.call(e);
        if(sr){if(seen.has(sr))throw Error('Duplicate native root');seen.add(sr);roots.push(sr);}
      }
    }
    return {count:fields.length,fields,all,incomplete};
  };
  let failed=false;
  const out={assertComplete:()=>{if(failed)throw Error('Incomplete native DOM traversal');}};
  for(const [key,fn] of Object.entries(api))out[key]=(...args)=>{try{return fn(...args);}catch(error){failed=true;throw error;}};
  return out;
}`;
