import {createRequire} from "node:module";
import {lstatSync,realpathSync} from "node:fs";
import path from "node:path";
const require=createRequire(import.meta.url);
/** A main-owned, finite, asynchronous authority gate. No renderer grant. */
export function createNotificationAuthorization({platform=process.platform,resourcesPath=process.resourcesPath,load=require,timeoutMs=60000}={}){
 let bridge=null,pending=null,stopped=false,generation=0;
 const unavailable={authorized:false,status:"unavailable"};
 const decode=value=>{
  if(!value||value.failed||!Number.isInteger(value.authorization)||!Number.isInteger(value.alert))return unavailable;
  return{authorized:value.authorization===2&&value.alert===2,status:value.authorization===2?"authorized":value.authorization===1?"denied":value.authorization===0?"not-determined":"unavailable"};
 };
 function binding(){
  if(bridge)return bridge;
  const file=path.join(resourcesPath,"notification-authorization.node"),stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o022)||realpathSync(file)!==file)throw Error("NOTIFICATION_AUTH_UNAVAILABLE");
  bridge=load(file);if(typeof bridge?.request!=="function"||typeof bridge?.status!=="function")throw Error("NOTIFICATION_AUTH_UNAVAILABLE");return bridge;
 }
 return{
  async ensure(){
   if(platform!=="darwin")return{authorized:true,status:"not-required"};
   if(stopped)return unavailable;if(pending)return pending;
   const epoch=generation;let timer;
   const work=Promise.resolve().then(()=>binding().request()).then(decode).catch(()=>unavailable);
   pending=Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve(unavailable),timeoutMs);timer.unref?.();})]).then(value=>stopped||epoch!==generation?unavailable:value).finally(()=>{clearTimeout(timer);pending=null;});
   return pending;
  },
  async current(){
   if(platform!=="darwin")return{authorized:true,status:"not-required"};if(stopped)return unavailable;
   const epoch=generation;let timer;
   try{return await Promise.race([Promise.resolve().then(()=>binding().status()).then(value=>stopped||epoch!==generation?unavailable:decode(value)).catch(()=>unavailable),new Promise(resolve=>{timer=setTimeout(()=>resolve(unavailable),5000);timer.unref?.();})]);}finally{clearTimeout(timer);}
  },
  invalidate(){stopped=true;generation++;},
 };
}
