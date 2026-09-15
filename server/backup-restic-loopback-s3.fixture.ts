import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixture-only S3-compatible loopback service for qualifying the pinned restic
// transport. Path-style, one bucket, in-memory objects. It checks the access key
// id carried by SigV4 but deliberately does not verify signatures.
export interface LoopbackRequest { method:string; key:string; query:string; status:number; bytes:number; accessKeyId?:string }
export interface LoopbackFaultInput { method:string; key:string; query:URLSearchParams; attempt:number }
export type LoopbackFault=(input:LoopbackFaultInput)=>undefined|"reset"|{status:number;code:string};
export interface LoopbackS3 {
  endpoint:string; bucket:string; region:string; caFile:string; accessKeyId:string; secretAccessKey:string;
  objects:Map<string,{body:Buffer;modified:Date}>; requests:LoopbackRequest[];
  fault?:LoopbackFault; acceptedAccessKeyId:string; close():Promise<void>;
  /** IAM-like fixture split: the writer key may delete only lock objects. */
  maintenanceAccessKeyId:string; maintenanceSecretAccessKey:string; writerDeletes:"locks"|"any";
}
const xml=(value:string)=>value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const etag=(body:Buffer)=>`"${createHash("md5").update(body).digest("hex")}"`;

function decodeAwsChunked(raw:Buffer):Buffer{
  const parts:Buffer[]=[];let offset=0;
  for(;;){
    const end=raw.indexOf("\r\n",offset);if(end<0)throw Error("AWS_CHUNKED_INVALID");
    const size=Number.parseInt(raw.subarray(offset,end).toString("latin1").split(";")[0],16);
    if(!Number.isSafeInteger(size)||size<0)throw Error("AWS_CHUNKED_INVALID");
    offset=end+2;if(size===0)break;
    parts.push(raw.subarray(offset,offset+size));offset+=size+2;
  }
  return Buffer.concat(parts);
}

export async function startLoopbackS3(options:{bucket?:string;region?:string}={}):Promise<LoopbackS3>{
  const directory=mkdtempSync(join(tmpdir(),"murage-loopback-s3-"));
  const key=join(directory,"key.pem"),caFile=join(directory,"cert.pem");
  execFileSync("openssl",["req","-x509","-newkey","ec","-pkeyopt","ec_paramgen_curve:prime256v1","-nodes","-keyout",key,"-out",caFile,"-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1"],{stdio:"ignore"});
  const bucket=options.bucket??"murage-loopback",region=options.region??"us-east-1";
  const state:LoopbackS3={endpoint:"",bucket,region,caFile,accessKeyId:"AKIALOOPBACKFIXTURE",secretAccessKey:"loopback-fixture-secret-not-a-credential",objects:new Map(),requests:[],acceptedAccessKeyId:"AKIALOOPBACKFIXTURE",maintenanceAccessKeyId:"AKIALOOPBACKMAINTAIN",maintenanceSecretAccessKey:"loopback-maintenance-secret-not-a-credential",writerDeletes:"locks",close:async()=>{}};
  const attempts=new Map<string,number>();
  const respond=(response:ServerResponse,record:LoopbackRequest,status:number,headers:Record<string,string|number>,body?:Buffer|string)=>{
    record.status=status;response.writeHead(status,{"x-amz-request-id":"loopback",...headers});response.end(body);
  };
  const error=(response:ServerResponse,record:LoopbackRequest,status:number,code:string,head=false)=>{
    const body=`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message><Resource>/${xml(record.key)}</Resource><RequestId>loopback</RequestId></Error>`;
    respond(response,record,status,{"content-type":"application/xml"},head?undefined:body);
  };
  const handle=(request:IncomingMessage,response:ServerResponse,raw:Buffer)=>{
    const url=new URL(request.url??"/","https://127.0.0.1"),method=request.method??"GET";
    const segments=url.pathname.split("/").slice(1),requestBucket=decodeURIComponent(segments.shift()??""),objectKey=segments.map(decodeURIComponent).join("/");
    const record:LoopbackRequest={method,key:objectKey,query:url.search,status:0,bytes:raw.length};state.requests.push(record);
    const head=method==="HEAD";
    const credential=/Credential=([^/,\s]+)\//.exec(request.headers.authorization??"")?.[1];
    const maintenance=credential===state.maintenanceAccessKeyId;record.accessKeyId=credential;
    if(credential!==state.acceptedAccessKeyId&&!maintenance)return error(response,record,403,credential===state.accessKeyId?"ExpiredToken":"InvalidAccessKeyId",head);
    if(requestBucket!==bucket)return error(response,record,404,"NoSuchBucket",head);
    const counter=`${method} ${objectKey}`,attempt=(attempts.get(counter)??0)+1;attempts.set(counter,attempt);
    const injected=state.fault?.({method,key:objectKey,query:url.searchParams,attempt});
    if(injected==="reset"){record.status=-1;request.socket.destroy();return;}
    if(injected)return error(response,record,injected.status,injected.code,head);
    if(!objectKey){
      if(url.searchParams.has("location"))return respond(response,record,200,{"content-type":"application/xml"},`<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${region}</LocationConstraint>`);
      if(head)return respond(response,record,200,{});
      if(method==="GET"&&url.searchParams.get("list-type")==="2"){
        const prefix=url.searchParams.get("prefix")??"",delimiter=url.searchParams.get("delimiter")??"",encode=url.searchParams.get("encoding-type")==="url";
        const after=url.searchParams.get("continuation-token")??url.searchParams.get("start-after")??"",max=Math.min(1000,Number(url.searchParams.get("max-keys")??1000)||1000);
        const keys=[...state.objects.keys()].filter(name=>name.startsWith(prefix)&&name>after).sort();
        const contents:string[]=[],prefixes=new Set<string>();let last="",truncated=false;
        for(const name of keys){
          if(contents.length+prefixes.size>=max){truncated=true;break;}
          const rest=name.slice(prefix.length),split=delimiter?rest.indexOf(delimiter):-1;last=name;
          if(split>=0){prefixes.add(prefix+rest.slice(0,split+delimiter.length));continue;}
          const object=state.objects.get(name)!;const shown=encode?encodeURIComponent(name):xml(name);
          contents.push(`<Contents><Key>${shown}</Key><LastModified>${object.modified.toISOString()}</LastModified><ETag>${xml(etag(object.body))}</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`);
        }
        const common=[...prefixes].map(value=>`<CommonPrefixes><Prefix>${encode?encodeURIComponent(value):xml(value)}</Prefix></CommonPrefixes>`).join("");
        const body=`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${contents.length+prefixes.size}</KeyCount><MaxKeys>${max}</MaxKeys>${delimiter?`<Delimiter>${xml(delimiter)}</Delimiter>`:""}<IsTruncated>${truncated}</IsTruncated>${truncated?`<NextContinuationToken>${xml(last)}</NextContinuationToken>`:""}${contents.join("")}${common}${encode?"<EncodingType>url</EncodingType>":""}</ListBucketResult>`;
        return respond(response,record,200,{"content-type":"application/xml"},body);
      }
      return error(response,record,501,"NotImplemented",head);
    }
    if(url.searchParams.has("uploads")||url.searchParams.has("uploadId"))return error(response,record,501,"NotImplemented",head);
    if(method==="PUT"){
      const chunked=/aws-chunked/.test(String(request.headers["content-encoding"]??""))||String(request.headers["x-amz-content-sha256"]??"").startsWith("STREAMING-");
      let body:Buffer;try{body=chunked?decodeAwsChunked(raw):raw;}catch{return error(response,record,400,"IncompleteBody");}
      const declared=request.headers["x-amz-decoded-content-length"];
      if(declared!==undefined&&Number(declared)!==body.length)return error(response,record,400,"IncompleteBody");
      state.objects.set(objectKey,{body,modified:new Date()});
      return respond(response,record,200,{etag:etag(body)});
    }
    if(method==="DELETE"){
      if(!maintenance&&state.writerDeletes==="locks"&&!("/"+objectKey).includes("/locks/"))return error(response,record,403,"AccessDenied");
      state.objects.delete(objectKey);return respond(response,record,204,{});
    }
    if(method!=="GET"&&!head)return error(response,record,501,"NotImplemented");
    const object=state.objects.get(objectKey);if(!object)return error(response,record,404,"NoSuchKey",head);
    const common={etag:etag(object.body),"last-modified":object.modified.toUTCString(),"accept-ranges":"bytes","content-type":"application/octet-stream"};
    const range=/^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range??""));
    if(range&&(range[1]||range[2])){
      const size=object.body.length;let start=range[1]?Number(range[1]):Math.max(0,size-Number(range[2]));let end=range[1]&&range[2]?Math.min(size-1,Number(range[2])):size-1;
      if(!range[1]){end=size-1;}
      if(start>=size||start>end)return respond(response,record,416,{"content-range":`bytes */${size}`});
      const slice=object.body.subarray(start,end+1);
      return respond(response,record,206,{...common,"content-length":slice.length,"content-range":`bytes ${start}-${end}/${size}`},head?undefined:slice);
    }
    return respond(response,record,200,{...common,"content-length":object.body.length},head?undefined:object.body);
  };
  const server=createServer({key:readFileSync(key),cert:readFileSync(caFile)},(request,response)=>{
    const chunks:Buffer[]=[];
    request.on("data",chunk=>chunks.push(chunk));
    request.on("end",()=>{try{handle(request,response,Buffer.concat(chunks));}catch{if(!response.headersSent){response.writeHead(500);response.end();}}});
    request.on("error",()=>{});
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("LOOPBACK_S3_UNAVAILABLE");
  state.endpoint=`https://127.0.0.1:${address.port}`;
  state.close=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});};
  return state;
}
