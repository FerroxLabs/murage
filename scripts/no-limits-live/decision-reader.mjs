import {openSync,closeSync,fstatSync,readSync} from 'node:fs';
// One byte cursor for the append-only observer and one index per owned thread.
export class DecisionReader {
 constructor(file){this.file=file;this.offset=0;this.bytesRead=0;this.pending=Buffer.alloc(0);this.threads=new Map();}
 read(threadIds) {
  const fd=openSync(this.file,'r');
  try{
   const stat=fstatSync(fd),identity=`${stat.dev}:${stat.ino}`;
   if(this.identity&&this.identity!==identity||stat.size<this.offset)throw Error('Decision observer was replaced or truncated');
   this.identity=identity;
   while(this.offset<stat.size){
    const buf=Buffer.alloc(Math.min(65536,stat.size-this.offset)),n=readSync(fd,buf,0,buf.length,this.offset);
    if(!n)throw Error('Decision observer read did not advance');
    this.offset+=n;this.bytesRead+=n;
    const bytes=Buffer.concat([this.pending,buf.subarray(0,n)]);let start=0,index;
    while((index=bytes.indexOf(10,start))!==-1){
     const line=bytes.subarray(start,index).toString('utf8');start=index+1;if(!line)continue;
     const {threadId,requestId,decision,source,rule}=JSON.parse(line);
     if(threadId){if(!this.threads.has(threadId))this.threads.set(threadId,[]);this.threads.get(threadId).push({threadId,requestId,decision,source,rule});}
    }
    this.pending=bytes.subarray(start);
   }
   return (threadIds??[...this.threads.keys()]).flatMap(id=>this.threads.get(id)??[]);
  }finally{closeSync(fd);}
 }
}
