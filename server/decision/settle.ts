// SPDX-License-Identifier: AGPL-3.0-or-later
// One unref'd timer for all request deadlines. Removed entries never retain work.
type Entry={at:number;id:number;fire:()=>void};
const heap:Entry[]=[];let timer:ReturnType<typeof setTimeout>|undefined,seq=0;
function arm(){if(timer)clearTimeout(timer);timer=undefined;if(!heap.length)return;timer=setTimeout(()=>{timer=undefined;const now=Date.now();while(heap.length&&heap[0].at<=now){const e=pop()!;e.fire();}arm();},Math.max(0,heap[0].at-Date.now()));timer.unref?.();}
function pop(){const head=heap[0],tail=heap.pop();if(heap.length&&tail){heap[0]=tail;let i=0;while(true){let j=i*2+1;if(j>=heap.length)break;if(j+1<heap.length&&heap[j+1].at<heap[j].at)j++;if(heap[i].at<=heap[j].at)break;[heap[i],heap[j]]=[heap[j],heap[i]];i=j;}}return head;}
function add(e:Entry){heap.push(e);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].at<=e.at)break;heap[i]=heap[p];i=p;}heap[i]=e;arm();}
function remove(id:number){const index=heap.findIndex(e=>e.id===id);if(index<0)return;const rest=heap.filter(e=>e.id!==id);heap.length=0;for(const e of rest)add(e);arm();}
export function withDeadline<T>(work:Promise<T>,ms:number):Promise<T>{return new Promise((resolve,reject)=>{const id=++seq;let done=false;add({id,at:Date.now()+ms,fire:()=>{if(done)return;done=true;reject(new Error('decision-deadline'));}});work.then(v=>{if(done)return;done=true;remove(id);resolve(v);},e=>{if(done)return;done=true;remove(id);reject(e);});});}
export function deadlineCount(){return heap.length;}
