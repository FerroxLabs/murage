// SPDX-License-Identifier: AGPL-3.0-or-later
// Run with Node type stripping. MURAGE_TEST_JSDOM points to an existing jsdom
// entry point when it is supplied by an offline verification environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInContext } from 'node:vm';
import { collectFloorFacts, COLLECT_FLOOR_FACTS_SOURCE, COLLECT_RECIPIENTS_SOURCE, EFFECT_TARGET_SOURCE, RELATED_ELEMENTS_SOURCE } from '../server/browser-floor-facts.ts';
import { checkIntent, recipientUnknown } from '../server/browser-intent.ts';
import { classifyFloor } from '../server/browser-floor.ts';
import { COVER_SOURCE } from '../server/browser-extension-snapshot.ts';
import * as pageScripts from '../server/browser-extension-page-scripts.ts';
import { BROWSER_DOCUMENT_GUARD_SOURCE } from '../server/browser-document-guard.ts';
import { NATIVE_DOM_SOURCE } from '../server/browser-native-dom.ts';
import { inspectClosedRoots } from '../server/browser-extension-dom-inspection.ts';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require(process.env.MURAGE_TEST_JSDOM || 'jsdom');
const options = { operation: 'click', selectors: { consent: [], captcha: [], payment: [], paymentRequest: [], challenge: [] }, currency: { source: '[$][0-9]', flags: '' } };
function fixture(html, setup = () => {}) {
  const errors = [];
  const console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, { url: 'https://fixture.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  const w = dom.window;
  const selected = setup(w);
  const target = selected || w.document.querySelector('#go') || w.document.querySelector('button,a');
  // jsdom has no layout engine. Only geometry is supplied; all traversal,
  // collections, receiver checks, attributes and events use its DOM implementation.
  w.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 });
  w.Document.prototype.elementFromPoint = () => target;
  w.ShadowRoot.prototype.elementFromPoint = () => target;
  const context = dom.getInternalVMContext();
  const expression = source => runInContext(source, context);
  const call = (source, receiver = target, ...args) => expression(`(${source})`).apply(receiver, args);
  return { w, target, call, expression, errors, close: () => w.close() };
}
// Capture the pager at the actual CDP boundary, rather than copying its body.
let pagerSource;
await inspectClosedRoots(async (method, params) => {
  if (method === 'DOM.getDocument' || method === 'DOM.describeNode') return { root: { backendNodeId: 1, childNodeCount: 1 }, node: { backendNodeId: 1, childNodeCount: 1 } };
  if (method === 'DOM.resolveNode') return { object: { objectId: 'root' } };
  if (method === 'Runtime.callFunctionOn') { pagerSource = params.functionDeclaration; throw Error('Captured pager'); }
  return {};
}, async () => 1, async () => undefined).catch(() => {});
assert.ok(pagerSource);
function collectors(f, hostile = false) {
  const check = fn => { try { fn(); } catch (error) {
    // jsdom's selector engine is implemented in JavaScript and can encounter
    // the deliberately throwing properties. The collector must refuse it.
    if (!hostile || !/Incomplete native DOM traversal|page getter/.test(error.message)) throw error;
  } };
  check(() => {
  const raw = f.call(COLLECT_FLOOR_FACTS_SOURCE, f.target, options);
  if (!hostile) { assert.equal(raw.nearFailed, false); assert.equal(raw.valuesCapped, false); assert.equal(raw.fieldsCapped, false); }
  });
  check(() => assert.ok(f.call(EFFECT_TARGET_SOURCE, f.target, 'click')));
  check(() => assert.ok(Array.isArray(f.call(RELATED_ELEMENTS_SOURCE))));
  check(() => assert.ok(JSON.parse(f.call(pageScripts.DESCRIBE_TARGET_SOURCE)).display));
  assert.equal(f.call(COVER_SOURCE), null);
  assert.equal(f.call(pageScripts.COMPOSED_HIT_TEST_SOURCE, f.target, 10, 10), true);
  assert.equal(f.call(pageScripts.COMPOSED_ACTIVE_SOURCE), f.target);
  check(() => assert.equal(typeof f.expression(pageScripts.presentedLinkExpression('https://fixture.test/next')), 'boolean'));
  const html = f.expression(pageScripts.htmlSliceExpression(0, 200));
  assert.ok(html.length > 0); assert.ok(f.expression(pageScripts.HTML_LENGTH_EXPRESSION) >= html.length);
  const page = f.call(pagerSource, f.w.document.body)(0, 64);
  assert.equal(page.length, Math.min(page.total, 64));
  f.expression(BROWSER_DOCUMENT_GUARD_SOURCE);
  assert.equal(typeof f.w.__murageGuard(), 'boolean');
  if (!hostile) assert.equal(f.w.__murageGuard(), false);
}
const ordinary = [
  ['plain button', '<button id="go">Go</button>'],
  ['form', '<form><label for="to">To</label><input id="to" value="alice@example.com"><button id="go">Send</button></form>'],
  ['link', '<a id="go" href="/next">Next</a>'],
  ['large table', '<button id="go">Go</button><table>' + '<tr><td>Product</td><td>Price</td></tr>'.repeat(5000) + '</table>'],
];
for (const [name, html] of ordinary) test(`serialized collectors: ${name}`, () => {
  const f = fixture(html); try {
    collectors(f);
    const result = f.call(COLLECT_RECIPIENTS_SOURCE);
    assert.equal(result.incomplete, false);
    if (name === 'link') assert.equal(result.sendCapable, false);
    else assert.equal(result.noRecipientField, name !== 'form');
    if (name === 'form') assert.deepEqual([...result.recipients], ['alice@example.com']);
  } finally { f.close(); }
});
test('ordinary events do not poison the next document guard check', () => {
  const f = fixture('<button id="go">Go</button>'); try {
    f.expression(BROWSER_DOCUMENT_GUARD_SOURCE);
    for (const type of ['click', 'pointerdown', 'mousedown', 'keydown', 'beforeinput', 'input', 'change', 'submit']) {
      f.w.__murageGuard.enable(true);
      f.target.dispatchEvent(new f.w.Event(type, { bubbles: true, composed: true }));
      f.w.__murageGuard.enable(true);
      assert.equal(f.w.__murageGuard(), false, type);
    }
    assert.equal(f.errors.length, 0);
  } finally { f.close(); }
});
test('a plain Go button with the extension overlay has no recipient line', () => {
  const f = fixture('<button id="go">Go</button>', w => {
    const host = w.document.createElement('murage-presence');
    w.document.documentElement.append(host); host.attachShadow({ mode: 'closed' });
  }); try { assert.equal(f.call(COLLECT_RECIPIENTS_SOURCE).incomplete, false); } finally { f.close(); }
});
const hostile = [];
for (const property of ['children', 'childNodes', 'elements', 'firstElementChild', 'querySelectorAll', 'getAttribute', 'shadowRoot', 'length']) {
  for (const picker of ['<input type="email" value="unrequested@example.com">', '<select><option value="unrequested@example.com">Alice</option></select>']) {
    hostile.push([`named ${property} ${picker.startsWith('<select') ? 'select' : 'input'}`, `<form aria-label="To"><input type="hidden" name="${property}">${picker}</form>`]);
  }
}
hostile.push(['labelledby', '<span id="label">To</span><input aria-labelledby="label" value="unrequested@example.com">']);
hostile.push(['fourth label', '<span id="a">Name</span><span id="b">Name</span><span id="c">Name</span><span id="label">To</span><input aria-labelledby="a b c label" value="unrequested@example.com">']);
hostile.push(['combobox', '<div role="combobox" aria-label="To">unrequested@example.com</div>']);
hostile.push(['listbox', '<div role="listbox" aria-label="To"><span role="option" aria-selected="true">unrequested@example.com</span></div>']);
for (const [name, markup] of hostile) test(`serialized hostile collectors: ${name}`, () => {
  const f = fixture('<button id="go">Send</button><div id="host"></div>', w => {
    const root = w.document.querySelector('#host').attachShadow({ mode: 'open' });
    root.innerHTML = markup;
    // jsdom does not implement every legacy named form property. Recreate the
    // browser's own-property shape with the actual control, keeping native DOM internals.
    for (const hidden of root.querySelectorAll('input[type=hidden][name]')) Object.defineProperty(hidden.form, hidden.name, { value: hidden });
  }); try {
    collectors(f, true);
    const result = f.call(COLLECT_RECIPIENTS_SOURCE);
    assert.equal(result.noRecipientField, false);
    assert.ok(result.incomplete || result.recipients.includes('unrequested@example.com'));
    if (name === 'named getAttribute select') assert.ok(result.recipients.includes('unrequested@example.com'));
  } finally { f.close(); }
});
for (const field of ['<input>', '<input type="number">', '<select><option>Alice</option></select>', '<textarea></textarea>', '<div contenteditable="plaintext-only"></div>', ...['textbox','combobox','listbox','searchbox','spinbutton'].map(role => `<div role="${role}"></div>`)]) test(`presence cannot disappear: ${field}`, () => {
  const f = fixture(`<button id="go">Send</button>${field}`); try {
    const result = f.call(COLLECT_RECIPIENTS_SOURCE);
    assert.equal(result.noRecipientField, false); assert.equal(result.incomplete, true);
  } finally { f.close(); }
});
test('positively named contenteditable composer is a field, not absence', () => {
  const f = fixture('<div contenteditable="true" role="textbox" aria-label="Message">Hello</div><button id="go">Send</button>');
  try { assert.equal(f.call(COLLECT_RECIPIENTS_SOURCE).noRecipientField, false); } finally { f.close(); }
});
test('HTMLFormControlsCollection uses captured inherited collection accessors', () => {
  const f = fixture('<form><input name="length"><input name="item"><button id="go">Go</button></form>');
  try { const dom = f.call(NATIVE_DOM_SOURCE); assert.equal(dom.elements(f.w.document.querySelector('form')).length, 3); } finally { f.close(); }
});
for (const property of ['querySelectorAll', 'getAttribute', 'shadowRoot', 'children', 'childNodes', 'length', 'localName', 'nodeType']) test(`serialized custom element getter: ${property}`, () => {
  const f = fixture('<x-compose><input type="email" value="unrequested@example.com"><button id="go">Send</button></x-compose>', w => {
    Object.defineProperty(w.document.querySelector('x-compose'), property, { get() { throw Error('page getter'); } });
  }); try {
    collectors(f, true);
    const result = f.call(COLLECT_RECIPIENTS_SOURCE);
    assert.equal(result.noRecipientField, false);
    assert.ok(result.incomplete || result.recipients.includes('unrequested@example.com'));
  } finally { f.close(); }
});
for (const fault of ['document element', 'element query', 'shadow query', 'attribute', 'shadow getter', 'length', 'item missing', 'item duplicate', 'length changes', 'selected options']) test(`native failure cannot establish absence: ${fault}`, () => {
  const f = fixture('<button id="go">Send</button><div id="host"></div>', w => {
    w.document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<form aria-label="To"><select><option value="unrequested@example.com">Alice</option></select><input aria-label="Message"></form>';
  }); try {
    const w = f.w;
    const fail = () => { throw new TypeError('Illegal invocation'); };
    const getter = (proto, key, get) => Object.defineProperty(proto, key, { configurable: true, get });
    if (fault === 'document element') getter(w.Document.prototype, 'documentElement', fail);
    if (fault === 'element query') w.Element.prototype.querySelectorAll = fail;
    if (fault === 'shadow query') w.DocumentFragment.prototype.querySelectorAll = fail;
    if (fault === 'attribute') w.Element.prototype.getAttribute = fail;
    if (fault === 'shadow getter') getter(w.Element.prototype, 'shadowRoot', fail);
    if (fault === 'length') getter(w.NodeList.prototype, 'length', fail);
    if (fault === 'item missing') w.NodeList.prototype.item = () => null;
    if (fault === 'item duplicate') { const item = w.NodeList.prototype.item; w.NodeList.prototype.item = function() { return item.call(this, 0); }; }
    if (fault === 'length changes') { const get = Object.getOwnPropertyDescriptor(w.NodeList.prototype, 'length').get; const reads = new WeakMap(); getter(w.NodeList.prototype, 'length', function() { const n = (reads.get(this) || 0) + 1; reads.set(this, n); return get.call(this) + (n > 1 ? 1 : 0); }); }
    if (fault === 'selected options') getter(w.HTMLSelectElement.prototype, 'selectedOptions', fail);
    let result;
    try { result = f.call(COLLECT_RECIPIENTS_SOURCE); } catch { result = { incomplete: true, noRecipientField: false }; }
    assert.equal(result.incomplete, true); assert.notEqual(result.noRecipientField, true); assert.notEqual(result.composerOnly, true);
  } finally { f.close(); }
});
test('a composer with an unreadable name cannot inherit conversation approval', () => {
  const f = fixture('<div contenteditable="true" aria-label="Message" aria-labelledby="missing"></div><button id="go">Send</button>');
  try { const result = f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(result.noRecipientField, false); assert.equal(result.composerOnly, false); assert.equal(result.incomplete, true); } finally { f.close(); }
});
test('native presence reads fields outside a form and beyond its open shadow root', () => {
  const f = fixture('<form><input type="email" value="alice@example.com"><button id="go">Send</button></form><div id="host"></div>', w => {
    w.document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<select aria-label="Bcc"><option value="unrequested@example.com">Alice</option></select>';
  }); try { const result = f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(result.noRecipientField, false); assert.ok(result.recipients.includes('unrequested@example.com')); } finally { f.close(); }
});
for (const markup of ['<input type="password">', '<input autocomplete="one-time-code">', '<input aria-label="Card number">']) test(`serialized private open root: ${markup}`, () => {
  const f = fixture('<button id="go">Send</button><div id="host"></div>', w => {
    w.document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = markup;
  }); try {
    f.expression(BROWSER_DOCUMENT_GUARD_SOURCE); assert.equal(f.w.__murageGuard(), true);
    f.w.__murageGuard.enable(true);
    assert.equal(f.target.dispatchEvent(new f.w.Event('click', { bubbles: true, composed: true, cancelable: true })), false);
    const result = f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(result.noRecipientField, false); assert.equal(result.incomplete, false); assert.equal(result.recipients.length, 0);
  } finally { f.close(); }
});
// A DOM-backed CDP adapter. Every functionDeclaration is evaluated exactly as
// inspectClosedRoots sends it, including the closure call used for each slice.
async function inspectFixture(f, closedRoots) {
  const nodes = new Map(), ids = new WeakMap(), objects = new Map(); let next = 1;
  const id = node => { if (!ids.has(node)) { ids.set(node, next); nodes.set(next++, node); } return ids.get(node); };
  const handle = node => { const key = `object-${next++}`; objects.set(key, node); return key; };
  const nodeType = Object.getOwnPropertyDescriptor(f.w.Node.prototype, 'nodeType').get;
  const children = Object.getOwnPropertyDescriptor(f.w.Node.prototype, 'childNodes').get;
  const local = Object.getOwnPropertyDescriptor(f.w.Element.prototype, 'localName').get;
  const describe = (node, depth) => {
    const type = nodeType.call(node), kids = Array.from(children.call(node));
    const result = { backendNodeId: id(node), nodeType: type, nodeName: node.nodeName, localName: type === 1 ? local.call(node) : '', childNodeCount: kids.length, children: depth > 0 && kids.length <= 64 ? kids.map(child => describe(child, depth - 1)) : [] };
    if (closedRoots.has(node)) result.shadowRoots = [{ ...describe(closedRoots.get(node), depth), shadowRootType: 'closed' }];
    return result;
  };
  return inspectClosedRoots(async (method, params = {}) => {
    if (method === 'DOM.getDocument') return { root: describe(f.w.document, params.depth) };
    if (method === 'DOM.describeNode') return { node: describe(params.objectId ? objects.get(params.objectId) : nodes.get(params.backendNodeId), params.depth) };
    if (method === 'DOM.resolveNode') return { object: { objectId: handle(nodes.get(params.backendNodeId)) } };
    if (method === 'Runtime.callFunctionOn') {
      try { const result = f.call(params.functionDeclaration, objects.get(params.objectId), ...(params.arguments || []).map(a => a.value)); return { result: { objectId: handle(result) } }; }
      catch (error) { return { exceptionDetails: { text: error.message } }; }
    }
    if (method === 'Runtime.getProperties') return { result: Object.entries(objects.get(params.objectId)).map(([name, value]) => ({ name, value: typeof value === 'object' ? { objectId: handle(value) } : { value } })).concat([{ name: 'length', value: { value: objects.get(params.objectId).length } }]) };
    if (method === 'Runtime.releaseObject') objects.delete(params.objectId);
    if (method === 'Runtime.releaseObjectGroup') objects.clear();
    return {};
  }, async () => 1, async () => undefined);
}
for (const property of ['children', 'childNodes', 'firstChild', 'length']) for (const closed of [false, true]) test(`serialized inspector wide named ${property}, closed=${closed}`, async () => {
  const roots = new Map();
  const f = fixture(`<form><input type="hidden" name="${property}"><div id="hidden"></div>${'<span data-murage-presence></span>'.repeat(12000)}</form><button id="go">Go</button>`, w => {
    if (closed) { const host = w.document.querySelector('#hidden'); roots.set(host, host.attachShadow({ mode: 'closed' })); }
  }); try {
    collectors(f, true);
    const recipients = f.call(COLLECT_RECIPIENTS_SOURCE);
    // A hidden control named only after a DOM property is now unknown.
    assert.equal(recipients.incomplete, true);
    assert.equal(await inspectFixture(f, roots), closed);
  } finally { f.close(); }
});
for (const field of ['<input type="email" value="Alice">', '<select aria-label="To"><option>Alice</option></select>', '<div role="combobox" aria-label="To">Alice</div>']) test(`a named but unreadable recipient still asks: ${field}`, () => {
  const f = fixture(`<button id="go">Send</button>${field}`);
  try { const result = f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(result.noRecipientField, false); assert.equal(result.incomplete, true); } finally { f.close(); }
});
for (const field of ['<div role="combobox" aria-label="To" aria-valuetext="unrequested@example.com"></div>', '<div role="combobox" aria-label="To" aria-activedescendant="chosen"></div><div id="chosen" role="option">unrequested@example.com</div>']) test(`combobox value is positively read: ${field}`, () => {
  const f = fixture(`<button id="go">Send</button>${field}`);
  try { const result = f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(result.noRecipientField, false); assert.ok(result.recipients.includes('unrequested@example.com')); } finally { f.close(); }
});
test('exact R4 review: named getAttribute, select, and script Send beside the form in an open root', () => {
  const f = fixture('<div id="host"></div>', w => {
    const root = w.document.querySelector('#host').attachShadow({ mode: 'open' });
    root.innerHTML = '<form aria-label="To"><input type="hidden" name="getAttribute"><select><option value="unrequested@example.com">Alice</option></select></form><button id="go">Send</button>';
    const form = root.querySelector('form'); Object.defineProperty(form, 'getAttribute', { value: root.querySelector('input') });
    return root.querySelector('#go');
  }); try {
    collectors(f, true);
    const result = f.call(COLLECT_RECIPIENTS_SOURCE);
    assert.equal(result.noRecipientField, false);
    assert.ok(result.recipients.includes('unrequested@example.com'));
  } finally { f.close(); }
});

// Round 6: the owner's strict inventory and action-kind contract.
for (const [name, html, setup] of [
  ['hidden outside body', '<button id="go">Send</button>', w => { const host = w.document.createElement('div'); w.document.documentElement.append(host); host.attachShadow({mode:'open'}).innerHTML = '<input type="hidden" name="to" value="unrequested@example.com">'; }],
  ['checked checkbox', '<input type="checkbox" name="to" checked value="unrequested@example.com"><button id="go">Send</button>'],
  ['checked radio', '<input type="radio" name="to" checked value="unrequested@example.com"><button id="go">Send</button>'],
  ['mixed selected values', '<select multiple aria-label="To"><option selected value="alice@example.com">Alice</option><option selected value="bob">Bob</option></select><button id="go">Send</button>'],
  ['editable recipient', '<div contenteditable aria-label="To">unrequested@example.com</div><button id="go">Send</button>'],
]) test(`strict inventory: ${name}`, () => {
  const f = fixture(html, setup); try {
    collectors(f, true);
    const result = f.call(COLLECT_RECIPIENTS_SOURCE);
    assert.equal(result.noRecipientField, false);
    if (name === 'mixed selected values') assert.equal(result.incomplete, true);
    else assert.ok(result.incomplete || result.recipients.includes('unrequested@example.com'));
  } finally { f.close(); }
});
for (const [operation, key, target] of [
  ['dialog_accept', null, '<button id="go">Send</button>'], ['dialog_dismiss', null, '<button id="go">Send</button>'],
  ['fill', null, '<input id="go">'], ['type', null, '<input id="go">'], ['hover', null, '<button id="go">Send</button>'],
  ['focus', null, '<input id="go">'], ['read', null, '<button id="go">Send</button>'], ['scroll', null, '<button id="go">Send</button>'],
  ['click', null, '<a id="go" href="https://fixture.test/next">Next</a>'], ['click', null, '<a id="go" href="/file" download>Download</a>'],
  ['press', 'a', '<input id="go">'],
]) test(`strict quiet action: ${operation} ${target}`, () => {
  const f = fixture(target + '<input aria-label="To" value="unrequested@example.com">'); try {
    const result = f.call(COLLECT_RECIPIENTS_SOURCE, f.target, operation, key);
    assert.equal(result.sendCapable, false); assert.equal(result.incomplete, false); assert.equal(result.recipients.length, 0);
  } finally { f.close(); }
});
test('strict private form identity survives associated named id control', () => {
  const f = fixture('<form id="password" contenteditable>Enter here</form><input type="hidden" form="password" name="id">', w => {
    const form = w.document.querySelector('form'); Object.defineProperty(form, 'id', {value:w.document.querySelector('input')}); return form;
  }); try {
    f.expression(BROWSER_DOCUMENT_GUARD_SOURCE); assert.equal(f.w.__murageGuard(), true);
    const facts = f.call(COLLECT_FLOOR_FACTS_SOURCE, f.target, {...options, operation:'fill'});
    assert.match(facts.fieldName, /password/);
  } finally { f.close(); }
});
test('OR-3 serialized: next armed check finds a password rendered inside an open root', () => {
  const f = fixture('<button id="go">Go</button><x-login></x-login>', w => {
    w.document.querySelector('x-login').attachShadow({mode:'open'}).innerHTML = '<input name="email">';
  }); try {
    f.expression(BROWSER_DOCUMENT_GUARD_SOURCE); f.w.__murageGuard.enable(true); assert.equal(f.w.__murageGuard(), false);
    f.w.document.querySelector('x-login').shadowRoot.innerHTML = '<input type="password">';
    assert.equal(f.w.__murageGuard(), true);
  } finally { f.close(); }
});

// Run collection through the server assembly as well as the exact page strings.
async function assembled(f, operation='click', key=null) {
  let effect=f.target;
  const objects=new Map([['target',f.target]]); let seq=0;
  const io={world:async()=>1, send:async(method,params={})=>{
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:'https://fixture.test/'}}};
    if(method==='DOM.resolveNode')return {object:{objectId:'target'}};
    if(method==='DOM.describeNode')return {node:{backendNodeId:1}};
    if(method==='Accessibility.getPartialAXTree')return {nodes:[{backendDOMNodeId:1,role:{value:effect.localName==='button'?'button':'textbox'},name:{value:''},properties:[]}]};
    if(method==='Runtime.getProperties')return {result:[]};
    if(method==='Runtime.callFunctionOn'){
      try {
        const value=f.call(params.functionDeclaration,objects.get(params.objectId),...(params.arguments||[]).map(a=>a.value));
        if(params.returnByValue)return {result:{value}};
        const objectId=`value-${++seq}`; objects.set(objectId,value);
        if(params.functionDeclaration===EFFECT_TARGET_SOURCE)effect=value;
        return {result:{objectId}};
      }catch(error){return {exceptionDetails:{text:error.message}};}
    }
    return {};
  }};
  return collectFloorFacts(io,{backendNodeId:1,document:{tabId:1,navigationEpoch:1,origin:'https://fixture.test/',url:'https://fixture.test/'}},operation,{key});
}
function intentFor(facts, mode='full', hits=0) {
  return checkIntent({mode,ownerWords:['Send the message to alice@example.com'],taskSites:new Set(['https://fixture.test']),readOrigins:new Map(),probeFlagged:false,counters:{hits},
    visibility:{box:{x:0,y:0,width:100,height:30},inViewport:true,opacity:1,visibility:'visible',ariaHidden:false,coveredBy:null},
    action:{...facts,level:'L2',origin:'https://fixture.test'}});
}
for(const [name,markup] of hostile.concat([
  ['hidden outside body','<input type="hidden" name="to" value="unrequested@example.com">'],
  ['checked checkbox','<input type="checkbox" name="to" checked value="unrequested@example.com">'],
  ['mixed selected','<select multiple aria-label="To"><option selected value="alice@example.com">Alice</option><option selected value="bob">Bob</option></select>'],
  ['contenteditable','<div contenteditable aria-label="To">unrequested@example.com</div>'],
])) test(`strict assembled admission: ${name}`,async()=>{
  const f=fixture('<button id="go">Send</button>',w=>{
    const host=w.document.createElement('div');w.document.documentElement.append(host);
    const root=host.attachShadow({mode:'open'});root.innerHTML=markup;
    for(const hidden of root.querySelectorAll('input[type=hidden][name]'))if(hidden.form)Object.defineProperty(hidden.form,hidden.name,{value:hidden});
  });try{
    const facts=await assembled(f);
    assert.equal(facts.sendCapable,true);
    for(const mode of ['step','task','full']) {
      const decision=intentFor(facts,mode);
      assert.equal(decision.result,'card');assert.equal(decision.rule,'I2');
      assert.match(decision.line,/unrequested@example.com|could not check who this goes to/);
      const repeated=intentFor(facts,mode,2);
      assert.equal(repeated.rule,facts.recipientScanFailed?'I7':'I2');
    }
  }finally{f.close();}
});
for(const [operation,key,html] of [
  ['click',null,'<a id="go" href="/next">Next</a><input>'],
  ['click',null,'<a id="go" href="/file" download>Download</a><input>'],
  ['fill',null,'<input id="go"><input>'],['type',null,'<input id="go"><input>'],
  ['press','a','<input id="go"><input>'],['click',null,'<button id="go">Go</button>'],
])test(`strict assembled quiet: ${operation} ${html}`,async()=>{
  const f=fixture(html);try{
    const facts=await assembled(f,operation,key);
    assert.equal(facts.recipientScanFailed,undefined);assert.equal(facts.recipients,undefined);
    assert.equal(recipientUnknown(facts),false);assert.equal(intentFor(facts,'full',3).result,'pass');
  }finally{f.close();}
});
for(const kind of ['alert','confirm','prompt'])test(`strict targetless ${kind} answer`,async()=>{
  const facts=await collectFloorFacts({world:async()=>{throw Error('DOM not permitted');},send:async()=>{throw Error('DOM not permitted');}},undefined,'dialog_accept',{dialog:{kind,text:'Continue?'}});
  assert.equal(facts.recipientScanFailed,undefined);assert.equal(facts.recipients,undefined);assert.equal(recipientUnknown(facts),false);
  assert.notEqual(intentFor({...facts,hasTarget:false},'full',3).rule,'I7');
});
for(const [html,operation,key] of [
  ['<input id="go">','press','Enter'],['<textarea id="go"></textarea>','press','Enter'],
  ['<a id="go" href="javascript:void(0)">Send</a>','click',null],['<a id="go">Send</a>','click',null],
  ...['button','menuitem','link'].map(role=>[`<div id="go" role="${role}">Send</div>`,'click',null]),
  ...['submit','button','image'].map(type=>[`<input id="go" type="${type}" value="Send">`,'click',null]),
  ['<form id="go"></form>','submit',null],
])test(`strict send kind: ${operation} ${html}`,()=>{
  const f=fixture(html+'<input>');try{
    const result=f.call(COLLECT_RECIPIENTS_SOURCE,f.target,operation,key);
    assert.equal(result.sendCapable,true);assert.equal(result.incomplete,true);
  }finally{f.close();}
});
test('strict assembled private-name fill reaches the floor',async()=>{
  const f=fixture('<form id="password" contenteditable>Enter here</form><input type="hidden" form="password" name="id">',w=>{
    const form=w.document.querySelector('form');Object.defineProperty(form,'id',{value:w.document.querySelector('input')});return form;
  });try{assert.equal(classifyFloor(await assembled(f,'fill')).floor,'credentials');}finally{f.close();}
});
test('strict positive email and chat composer',async()=>{
  for(const html of ['<input aria-label="To" value="alice@example.com"><textarea aria-label="Message">Hello</textarea><button id="go">Send</button>','<div role="textbox" contenteditable aria-label="Message">Hello</div><button id="go">Send</button>']){
    const f=fixture(html);try{
      const facts=await assembled(f);
      if(html.startsWith('<input')){assert.deepEqual([...facts.recipients],['alice@example.com']);assert.equal(facts.recipientScanFailed,undefined);}
      else {assert.equal(facts.recipientComposer,true);assert.equal(facts.recipientScanFailed,true);assert.equal(intentFor({...facts,conversationApproved:true}).result,'pass');}
    }finally{f.close();}
  }
});
test('zero controls is quiet even beside non-editable recipient-like text', () => {
  const f=fixture('<div aria-label="To">Alice</div><button id="go">Go</button>');
  try {const r=f.call(COLLECT_RECIPIENTS_SOURCE);assert.equal(r.noRecipientField,true);assert.equal(r.incomplete,false);assert.equal(r.recipients.length,0);}finally{f.close();}
});
for(const field of ['<output aria-label="To">unrequested@example.com</output>','<button name="to" value="unrequested@example.com">Add</button>','<div role="option" aria-selected="true" aria-label="To">unrequested@example.com</div>','<div role="checkbox" aria-checked="true" aria-label="To">unrequested@example.com</div>','<div role="radio" aria-checked="true" aria-label="To">unrequested@example.com</div>'])test(`strict additional control: ${field}`,()=>{
  const f=fixture(field+'<button id="go">Send</button>');try{const r=f.call(COLLECT_RECIPIENTS_SOURCE);assert.equal(r.noRecipientField,false);assert.ok(r.recipients.includes('unrequested@example.com'));}finally{f.close();}
});
test('snapshot cover collector reads a clobbered form identity natively', () => {
  const f=fixture('<button id="go">Go</button><form id="overlay" role="dialog" style="position:fixed"><input name="id"><input name="getAttribute"></form>');
  try {
    const form=f.w.document.querySelector('form');
    Object.defineProperty(form,'id',{value:form.querySelector('input')});Object.defineProperty(form,'getAttribute',{value:form.querySelector('input')});
    f.w.Document.prototype.elementFromPoint=()=>form;
    const cover=f.call(COVER_SOURCE);assert.equal(cover.id,'overlay');assert.equal(cover.role,'dialog');
  }finally{f.close();}
});
for(const field of ['<input name="to" type="checkbox" checked value="">','<select aria-label="To"><option selected value="">Alice</option></select>','<div role="option" aria-selected="true" aria-label="To"></div>','<div role="checkbox" aria-checked="true" aria-label="To"></div>','<div role="listbox" aria-label="To">Alice</div>'])test(`selected value cannot resolve as empty: ${field}`,()=>{
  const f=fixture(field+'<button id="go">Send</button>');try{assert.equal(f.call(COLLECT_RECIPIENTS_SOURCE).incomplete,true);}finally{f.close();}
});

// Round 7: names need structure, containers retain their values, and coverage is explicit.
for (const label of ['Search', 'Message']) for (const identity of ['aria-label', 'name']) test(`R7 F2 naming alone ${identity}=${label}`, () => {
  const f=fixture(`<input ${identity}="${label}" value="bob@example.com"><button id="go">Send</button>`);
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(r.incomplete,true); assert.equal(r.composerOnly,false); } finally { f.close(); }
});
test('R7 F2 noneditable private ancestor does not discard recipient', () => {
  const f=fixture('<div id="password"><input type="email" value="bob@example.com"></div><button id="go">Send</button>');
  try { f.expression(BROWSER_DOCUMENT_GUARD_SOURCE); assert.equal(f.w.__murageGuard(),false); const r=f.call(COLLECT_RECIPIENTS_SOURCE); assert.ok(r.incomplete||r.recipients.includes('bob@example.com')); } finally { f.close(); }
});
for (const role of ['combobox','listbox','option']) for (const extra of ['', ' aria-valuetext="alice@example.com"']) test(`R7 F3 nested ${role}${extra}`, () => {
  const f=fixture(`<div role="${role}" aria-label="To"${extra}><span>bob@example.com</span><input aria-label="Search"></div><button id="go">Send</button>`);
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE); assert.ok(r.incomplete||r.recipients.includes('bob@example.com')); } finally { f.close(); }
});
for (const src of ['', ' src="https://other.test/"']) test(`R7 F4 iframe before zero-control return${src}`, () => {
  const f=fixture(`<iframe${src}></iframe><button id="go">Send</button>`);
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(r.incomplete,true); assert.equal(r.noRecipientField,false); } finally { f.close(); }
});
for (const role of ['switch','slider','menuitemcheckbox','menuitemradio','treeitem','gridcell']) test(`R7 F4 value role ${role}`, () => {
  const f=fixture(`<div role="${role}" aria-label="To" aria-checked="true" aria-selected="true">bob@example.com</div><button id="go">Send</button>`);
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(r.noRecipientField,false); assert.ok(r.incomplete||r.recipients.includes('bob@example.com')); } finally { f.close(); }
});
test('R7 F4 template content is inert and excluded', () => {
  const f=fixture('<template><input aria-label="To" value="bob@example.com"><iframe></iframe></template><button id="go">Send</button>');
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(r.incomplete,false); assert.equal(r.noRecipientField,true); } finally { f.close(); }
});
const { SENSITIVE_RECTS } = await import('../extensions/murage-browser/runtime.mjs');
for (const zero of [false,true]) test(`R7 F6 clobbered private ancestor, missing geometry=${zero}`, async () => {
  const f=fixture('<form id="password"><input value="violet"></form><input type="hidden" form="password" name="id">', w=>{
    Object.defineProperty(w.document.querySelector('form'),'id',{value:w.document.querySelector('[name=id]')});
  });
  try {
    f.w.Element.prototype.getBoundingClientRect=()=>({x:0,y:0,width:zero?0:100,height:zero?0:30});
    let masks; f.w.__muragePresence={capture:(_on,r)=>{masks=r;return true;}};
    const result=await f.expression(SENSITIVE_RECTS);
    if(zero)assert.equal(result,false);else { assert.equal(result,true);assert.ok(masks.length>0); }
  } finally { f.close(); }
});
for (const markup of ['<input type="search" aria-label="Search">','<div role="searchbox" aria-label="Search"></div>','<form role="search"><input aria-label="Search"></form>','<input role="combobox" aria-label="Find a person">']) test(`R7 F2 structured search ${markup}`, () => {
  const f=fixture(`${markup}<button id="go">Send</button>`);
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(r.incomplete,false);assert.equal(r.composerOnly,false); } finally { f.close(); }
});
for (const markup of ['<textarea aria-label="Message"></textarea>','<div role="textbox" aria-label="Message"></div>','<div contenteditable aria-label="Message"></div>']) test(`R7 F2 structured composer ${markup}`, () => {
  const f=fixture(`${markup}<button id="go">Send</button>`);
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE); assert.equal(r.composerOnly,true); } finally { f.close(); }
});
for (const role of ['combobox','listbox','option']) test(`R7 F3 container text survives a positively classified child search ${role}`, () => {
  const f=fixture(`<div role="${role}" aria-label="To" aria-valuetext="alice@example.com"><span>bob@example.com</span><input type="search" aria-label="Search"></div><button id="go">Send</button>`);
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE); assert.ok(r.recipients.includes('alice@example.com'));assert.ok(r.recipients.includes('bob@example.com')); } finally { f.close(); }
});
for (const role of ['switch','slider','menuitemcheckbox','menuitemradio','treeitem','gridcell']) test(`R7 F4 unresolved value in ${role} remains unknown`, () => {
  const f=fixture(`<div role="${role}" aria-label="To" aria-selected="true" aria-checked="true">Bob</div><button id="go">Send</button>`);
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE);assert.equal(r.incomplete,true);assert.equal(r.noRecipientField,false); } finally { f.close(); }
});
for (const nativeFailure of [false,true]) test(`R7 F6 empty masks cannot cover guard verdict or native failure=${nativeFailure}`, async () => {
  const f=fixture('<button id="go">Go</button>');
  try {
    let called=false;f.w.__muragePresence={capture:()=>{called=true;return true;}};
    if(nativeFailure)Object.defineProperty(f.w.Document.prototype,'documentElement',{get(){throw Error('native inventory failed');}});
    assert.equal(await f.expression(SENSITIVE_RECTS.replace('/*GUARD*/false','true')),false);assert.equal(called,false);
  } finally { f.close(); }
});
const { presenceSource } = await import('../extensions/murage-browser/presence.mjs');
test('R7 F6 presence refuses an empty mask list without a complete inventory', async () => {
  const f=fixture('<button id="go">Go</button>');
  try {
    f.expression(presenceSource());
    assert.equal(await f.w.__muragePresence.capture(true,[]),false);
    assert.equal(await f.w.__muragePresence.capture(true,[],true),true);
  } finally { f.close(); }
});
test('R7 F2 a non-input type attribute does not create a search field', () => {
  const f=fixture('<div role="slider" type="search" aria-label="Search" aria-valuenow="2"></div><button id="go">Send</button>');
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE);assert.equal(r.incomplete,true);assert.equal(r.composerOnly,false); } finally { f.close(); }
});
test('R7 F4 iframe in an open root prevents complete absence', () => {
  const f=fixture('<div id="host"></div><button id="go">Send</button>', w=>{
    w.document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<iframe></iframe>';
  });
  try { const r=f.call(COLLECT_RECIPIENTS_SOURCE);assert.equal(r.incomplete,true);assert.equal(r.noRecipientField,false); } finally { f.close(); }
});
for (const role of ['slider','spinbutton']) test(`R7 F4 missing value in ${role} is unknown`, () => {
  const f=fixture(`<div role="${role}" aria-label="To"></div><button id="go">Send</button>`);
  try { assert.equal(f.call(COLLECT_RECIPIENTS_SOURCE).incomplete,true); } finally { f.close(); }
});
test('R7 F6 native ancestor name survives a named name control', async () => {
  const f=fixture('<form id="private-form" name="password"><input value="violet"><input type="hidden" name="name"></form>',w=>{
    Object.defineProperty(w.document.querySelector('form'),'name',{value:w.document.querySelector('[name=name]')});
  });
  try {
    f.w.Element.prototype.getBoundingClientRect=()=>({x:2,y:3,width:100,height:30});
    let masks;f.w.__muragePresence={capture:(_on,r)=>{masks=r;return true;}};
    assert.equal(await f.expression(SENSITIVE_RECTS),true);assert.ok(masks.length>0);
  } finally { f.close(); }
});
test('R7 F6 a generic widget mask cannot cover an unlocated guard field', async () => {
  const f=fixture('<x-widget></x-widget><button id="go">Go</button>');
  try {
    let called=false;f.w.__muragePresence={capture:()=>{called=true;return true;}};
    assert.equal(await f.expression(SENSITIVE_RECTS.replace('/*GUARD*/false','true')),false);assert.equal(called,false);
  } finally { f.close(); }
});
