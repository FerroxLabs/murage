import {createServer} from 'node:http';
export async function startApiFixture(){
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const json=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url.endsWith('/models'))return json({data:[{id:'fake-model'}]});
  if(req.url.endsWith('/me'))return json({id:'fixture-owner'});
  if(req.url.endsWith('/chat/completions')){
   const body=JSON.parse(text||'{}');
   const reply={id:'fixture-completion',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'Fixture received prompt; no native action witness'},finish_reason:'stop'}]};
   if(!body.stream)return json(reply);
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.end(`data: ${JSON.stringify({...reply,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:reply.choices[0].message.content},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);return;
  }
  res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"Fixture endpoint unavailable"}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${server.address().port}/v1`,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
