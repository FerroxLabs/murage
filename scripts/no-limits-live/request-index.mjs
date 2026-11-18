// Index request-id suffixes without assuming ids or generations lack colons.
// Lookup follows only the current request key, independent of prior log size.
export function createRequestIndex(){
 const threads=new Map();let order=0;
 return {
  clear(){threads.clear();order=0;},
  add(t){
   if(t.type!=='request')return;
   let node=threads.get(t.threadId);if(!node){node={next:new Map()};threads.set(t.threadId,node);}
   for(const char of [...`:${t.requestId}`].reverse()){
    if(!node.next.has(char))node.next.set(char,{next:new Map()});node=node.next.get(char);
   }
   node.requests??=new Map();node.requests.set(t.providerInstanceId,{request:t,order:++order});
  },
  find(threadId,key){
   let node=threads.get(threadId),found;
   for(const char of [...key].reverse()){
    node=node?.next.get(char);if(!node)break;
    for(const entry of node.requests?.values()??[])
     if(key.startsWith(`${entry.request.providerInstanceId}:`)&&(!found||entry.order>found.order))found=entry;
   }
   return found?.request;
  },
 };
}
