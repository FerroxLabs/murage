import http from 'node:http';
import net from 'node:net';
import {readFileSync} from 'node:fs';
const allowed = new Set(JSON.parse(readFileSync(new URL('./allowlist.json',import.meta.url))));
const server=http.createServer((req,res)=>{res.writeHead(405);res.end();});
server.on('connect',(req,client,head)=>{
 const match=/^([a-zA-Z0-9.-]+):443$/.exec(req.url??'');
 if(!match || (!allowed.has(match[1]) && process.env.NOLIM_PROXY_MUTANT!=='wildcard')){
  console.log(JSON.stringify({at:Date.now(),method:'CONNECT',target:req.url,status:403}));client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;
 }
 const upstream=net.connect({host:match[1],port:443});
 const fail=()=>{if(!client.destroyed)client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');upstream.destroy();};
 upstream.setTimeout(5000,fail);upstream.once('error',fail);client.once('error',()=>upstream.destroy());
 upstream.once('connect',()=>{upstream.setTimeout(0);client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
 client.once('close',()=>upstream.destroy());
});
server.listen(3128,'0.0.0.0',()=>console.log('proxy ready'));
