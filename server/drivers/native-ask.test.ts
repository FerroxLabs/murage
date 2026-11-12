import {expect,it,vi} from 'vitest';
import {deliverNative,type NativeAskSlot} from './native-ask.ts';
it('N2 N5 live write failure keeps the slot and timer; coalesces and rejects another frame',async()=>{
 const slot:NativeAskSlot={closed:false},commit=vi.fn();let accept!:(ok:boolean)=>void;const write=vi.fn(()=>new Promise<boolean>(r=>{accept=r;}));
 const a=deliverNative(slot,'answer','a',write,()=>true,commit),b=deliverNative(slot,'answer','a',write,()=>true,commit);
 expect(a).toBe(b);expect(await deliverNative(slot,'answer','b',write,()=>true,commit)).toBe(false);await Promise.resolve();accept(false);expect(await a).toBe(false);expect(slot.closed).toBe(false);expect(commit).not.toHaveBeenCalled();
 expect(await deliverNative(slot,'answer','a',async()=>true,()=>true,commit)).toBe(true);expect(commit).toHaveBeenCalledTimes(1);
});
it('N3/M84 a failed write to a gone transport commits unavailable immediately',async()=>{const slot:NativeAskSlot={closed:false},commit=vi.fn();expect(await deliverNative(slot,'answer','a',async()=>false,()=>false,commit)).toBe(false);expect(slot.closed).toBe(true);expect(commit).toHaveBeenCalledExactlyOnceWith(false);});
it('N4 retire removes a failed ask even on a writable transport',async()=>{const slot:NativeAskSlot={closed:false},commit=vi.fn();expect(await deliverNative(slot,'retire','a',async()=>false,()=>true,commit)).toBe(false);expect(slot.closed).toBe(true);expect(commit).toHaveBeenCalledExactlyOnceWith(false);});

it('N5 retirement joins the identical frame and refuses a different in-flight frame',async()=>{
 const slot:NativeAskSlot={closed:false},firstCommit=vi.fn(),retireCommit=vi.fn();let accept!:(ok:boolean)=>void;
 const first=deliverNative(slot,'answer','a',()=>new Promise<boolean>(r=>{accept=r;}),()=>true,firstCommit);await Promise.resolve();
 expect(deliverNative(slot,'retire','a',async()=>true,()=>true,retireCommit)).toBe(first);
 expect(await deliverNative(slot,'retire','b',async()=>true,()=>true,retireCommit)).toBe(false);
 accept(false);expect(await first).toBe(false);await Promise.resolve();expect(slot.closed).toBe(true);expect(firstCommit).not.toHaveBeenCalled();expect(retireCommit).toHaveBeenCalledExactlyOnceWith(false);
});
