import net from 'node:net';
import dns from 'node:dns/promises';
export async function tcp(host,port=443){const at=Date.now();return new Promise(resolve=>{
 const s=net.connect({host,port});let done=false;
 const finish=reason=>{if(done)return;done=true;s.destroy();resolve({at,end:Date.now(),reason});};
 s.once('connect',()=>finish('connected'));s.once('error',e=>finish(e.code??'error'));s.setTimeout(3000,()=>finish('timeout'));
});}
export async function tunnel(proxy,host){const at=Date.now();return new Promise(resolve=>{
 const s=net.connect({host:proxy,port:3128});let done=false,buf='';
 const finish=reason=>{if(done)return;done=true;s.destroy();resolve({at,end:Date.now(),reason});};
 s.once('connect',()=>s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
 s.on('data',b=>{buf+=b;const match=/^HTTP\/1\.1 (\d+)/.exec(buf);if(match)finish(Number(match[1]));});
 s.once('error',e=>finish(e.code??'error'));s.setTimeout(7000,()=>finish('timeout'));
});}
if(process.argv[2]==='run'){
 const [proxy,control,ip,allowed]=process.argv.slice(3);const start=Date.now();
 const direct=await tcp(ip),denied=await tunnel(proxy,control),positive=await tunnel(proxy,allowed);
 let lookup;const at=Date.now();try{await dns.lookup(control);lookup={at,end:Date.now(),reason:'resolved'};}catch(e){lookup={at,end:Date.now(),reason:e.code};}
 console.log(JSON.stringify({start,end:Date.now(),direct,denied,positive,lookup}));
}
if(process.argv[2]==='control'){
 const host=process.argv[3];let ip;
 try{ip=(await dns.lookup(host,{family:4})).address;}catch{}
 console.log(JSON.stringify({host,ip,...await tcp(ip??host)}));
}
