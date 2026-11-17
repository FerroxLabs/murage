// Handle producer owner: gnl-harness-r11. Fake consumer owner: gnl-harness-r11.
const handles=new WeakSet();
export function sealGatedHandle(handle){handles.add(handle);return Object.freeze(handle);}
export function requireGatedHandle(handle){if(!handles.has(handle))throw Error('A gated fixture handle is required');return handle;}
