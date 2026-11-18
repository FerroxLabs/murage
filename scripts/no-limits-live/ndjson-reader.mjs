// Append-only fixture logs are consumed once. Index by thread so a later turn
// does not parse or scan all earlier turns. A replaced/truncated log resets it.
import {openSync,closeSync,readSync,fstatSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
export function createNdjsonReader(path,{validate=()=>{},onRow=()=>{},onReset=()=>{},requireComplete=false}={}){
 let failure,modified,offset=0,identity,checkpoint=Buffer.alloc(0),head=Buffer.alloc(0),tail='',decoder=new StringDecoder('utf8'),rows=[],threads=new Map();
 return (threadIds)=>{
  const fd=openSync(path,'r');
  try{
   const stat=fstatSync(fd,{bigint:true}),size=Number(stat.size),revision=`${stat.mtimeNs}:${stat.ctimeNs}`,key=`${stat.dev}:${stat.ino}`;
   if(!stat.isFile())throw Error('Fixture log is not a file');
   const prior=Buffer.alloc(checkpoint.length);
   if(prior.length&&size>=offset)readSync(fd,prior,0,prior.length,offset-prior.length);
   const prefix=Buffer.alloc(head.length);
   if(prefix.length&&size>=prefix.length)readSync(fd,prefix,0,prefix.length,0);
   if(identity!==key||!prefix.equals(head)||size<offset||!prior.equals(checkpoint)||size===offset&&revision!==modified){offset=0;tail='';decoder=new StringDecoder('utf8');rows=[];threads=new Map();identity=key;failure=undefined;onReset();}
   if(failure)throw failure;
   while(offset<size){
    const buffer=Buffer.alloc(Math.min(65536,size-offset)),bytes=readSync(fd,buffer,0,buffer.length,offset);
    if(!bytes)break;offset+=bytes;tail+=decoder.write(buffer.subarray(0,bytes));
    let newline;
    while((newline=tail.indexOf('\n'))>=0){
     const line=tail.slice(0,newline);tail=tail.slice(newline+1);if(!line.trim())continue;
     let row;try{row=JSON.parse(line);validate(row);}catch(error){failure=error;throw error;}rows.push(row);
     const list=threads.get(row.threadId)??[];list.push(row);threads.set(row.threadId,list);onRow(row);
    }
   }
   head=Buffer.alloc(Math.min(65536,offset));
   if(head.length)readSync(fd,head,0,head.length,0);
   modified=revision;
   checkpoint=Buffer.alloc(Math.min(256,offset));
   if(checkpoint.length)readSync(fd,checkpoint,0,checkpoint.length,offset-checkpoint.length);
  }finally{closeSync(fd);}
  if(requireComplete&&tail.trim())throw Error('Incomplete fixture log row');
  return threadIds?threadIds.flatMap(id=>threads.get(id)??[]):[...rows];
 };
}
const readers=new Map();
export function readFixtureLog(path,threadIds){
 if(!readers.has(path))readers.set(path,createNdjsonReader(path,{requireComplete:true}));
 return readers.get(path)(threadIds);
}
