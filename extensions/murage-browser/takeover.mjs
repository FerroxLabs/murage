// Browser-generated input has no public human/automation attribution flag.
// Correlate only a single expected dispatch; unexpected trusted input latches pause.
export const TAKEOVER_WORLD = 'murage-takeover-v1';
export function takeoverSource(bindingName) {
  return `(() => {
    if (globalThis.__murageTakeover) return;
    let paused = false, expectation;
    const signal = globalThis[${JSON.stringify(bindingName)}];
    const types = ['pointerdown','keydown','beforeinput','wheel','touchstart'];
    const handler = e => {
      if (!e.isTrusted || paused) return;
      const x = expectation;
      const matches = x && performance.now() <= x.deadline && x.types.includes(e.type) &&
        e.composedPath().includes(x.target) &&
        (e.type !== 'pointerdown' || (e.clientX === x.x && e.clientY === x.y && e.button === x.button)) &&
        (e.type !== 'keydown' || (e.key === x.key && e.altKey === x.alt && e.ctrlKey === x.ctrl && e.metaKey === x.meta && e.shiftKey === x.shift)) &&
        (e.type !== 'beforeinput' || (x.lineBreak ? e.data === null && ['insertLineBreak','insertParagraph'].includes(e.inputType) : e.data === x.text)) &&
        (e.type !== 'wheel' || (e.deltaX === x.dx && e.deltaY === x.dy));
      if (matches) { x.types.splice(x.types.indexOf(e.type), 1); return; }
      paused = true; expectation = undefined;
      try { signal('pause'); } catch { /* The local latch still blocks observations. */ }
    };
    for (const type of types) window.addEventListener(type, handler, true);
    const control = {
      state: () => paused,
      arm: (method, p) => {
        if (paused) return false;
        const x = {types:[], deadline:performance.now()+1000, target:document.activeElement};
        if (method === 'Input.dispatchMouseEvent' && p.type === 'mousePressed') {
          x.types=['pointerdown']; x.x=p.x; x.y=p.y; x.button=({left:0,middle:1,right:2})[p.button]; x.target=document.elementFromPoint(p.x,p.y);
        } else if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseWheel') {
          x.types=['wheel']; x.dx=p.deltaX; x.dy=p.deltaY; x.target=document.elementFromPoint(p.x,p.y);
        } else if (method === 'Input.dispatchKeyEvent') {
          if (p.type === 'keyDown' || p.type === 'rawKeyDown') x.types.push('keydown');
          if (p.text) x.types.push('beforeinput');
          x.key=p.key; x.text=p.text; x.lineBreak=p.key==='Enter'; const m=p.modifiers||0; x.alt=!!(m&1); x.ctrl=!!(m&2); x.meta=!!(m&4); x.shift=!!(m&8);
        } else if (method === 'Input.insertText') { x.types=['beforeinput']; x.text=p.text; }
        expectation=x; return true;
      },
      clear: () => { expectation=undefined; return paused; },
      remove: () => { for(const type of types) window.removeEventListener(type,handler,true); expectation=undefined; delete globalThis.__murageTakeover; }
    };
    Object.defineProperty(globalThis,'__murageTakeover',{value:control,configurable:true});
  })()`;
}
