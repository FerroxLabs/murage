export class MemoryQueryCache<T> {
  private entries=new Map<string,{value:T;bytes:number}>();
  private bytes=0;
  get(key:string){const entry=this.entries.get(key);if(!entry)return undefined;this.entries.delete(key);this.entries.set(key,entry);return entry.value;}
  set(key:string,value:T){
    const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>8*1024**2)return;
    const old=this.entries.get(key);if(old)this.bytes-=old.bytes;
    this.entries.delete(key);this.entries.set(key,{value,bytes});this.bytes+=bytes;
    while(this.entries.size>128||this.bytes>8*1024**2){const first=this.entries.keys().next().value!;this.bytes-=this.entries.get(first)!.bytes;this.entries.delete(first);}
  }
  clear(){this.entries.clear();this.bytes=0;}
}
