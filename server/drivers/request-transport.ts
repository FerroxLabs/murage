// A legacy method's return value is not a transport receipt. Only the native
// write/command boundary can confirm an explicitly identified answer.
export class RequestTransport {
 /** A provider may reopen a successfully answered native request only when
  * a new native RPC is waiting on the same captured operation. */
 onRearmReady?: (threadId:string,requestId:string)=>Promise<boolean>;
 guardRelease(threadId:string,requestId:string,check:()=>boolean):boolean {const allowed=check();if(!allowed)void this.onRearmReady?.(threadId,requestId).catch(()=>{});return allowed;}
 onReopenReady?: (threadId:string,requestId:string)=>Promise<boolean>;
 reopenAfterDelivery(threadId:string,requestId:string):Promise<boolean> {return this.onReopenReady?.(threadId,requestId)??Promise.resolve(false);}
 onReopen?: (threadId:string,requestId:string)=>boolean;
 reopen(threadId:string,requestId:string):boolean {return this.onReopen?.(threadId,requestId)===true;}
 onConfirmed?: (threadId: string, requestId: string, accepted: boolean) => void;
 /** Capture identity before a synchronous request.resolved removes the open entry. */
 onConfirming?: (threadId: string, requestId: string) => ((accepted: boolean) => void) | undefined;
 private pending = new Map<string, (accepted: boolean) => void>();
 private key(t: string, r: string) { return JSON.stringify([t,r]); }
 begin(t: string, r: string) {
  const key = this.key(t,r);
  let finish!: (accepted: boolean) => void;
  const done = new Promise<boolean>(resolve => { finish = resolve; });
  this.pending.set(key, finish);
  return { done, close: () => { if (this.pending.get(key) === finish) this.pending.delete(key); finish(false); } };
 }
 confirm(t: string, r: string, receipt: Promise<boolean>) {
  const finish = this.pending.get(this.key(t,r));
  const captured = this.onConfirming?.(t,r);
  void receipt.then(accepted => { finish?.(accepted); captured?.(accepted); this.onConfirmed?.(t,r,accepted); }, () => { finish?.(false); captured?.(false); this.onConfirmed?.(t,r,false); });
 }
 cancel(t: string, r: string) { const k = this.key(t,r); this.pending.get(k)?.(false); this.pending.delete(k); }
 clear() { for (const finish of this.pending.values()) finish(false); this.pending.clear(); }
}
