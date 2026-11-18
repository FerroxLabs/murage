// SPDX-License-Identifier: AGPL-3.0-or-later
// The tray reads the Inbox when the server says it changed, over the same event
// stream the window uses (`inbox.changed`, server/index.ts), instead of asking
// every 5 s. Reconnects back off from 5 s to 60 s and report one change on
// every (re)connect, because frames sent while it was down are not replayed.
// Effects are injected (options) so node --test can drive it without Electron.
const FRAME_MARKERS=['"attention.settled"','"kind":"bot"','"kind":"config"'];
export function watchInboxChanges(onChange,options){
  const fetchImpl=options.fetch??fetch,wait=options.setTimeout??setTimeout,cancel=options.clearTimeout??clearTimeout;
  let stopped=false,controller=null,timer=null,delay=5000;
  const pause=ms=>new Promise(resolve=>{timer=wait(resolve,ms);timer?.unref?.();});
  (async()=>{
    while(!stopped){
      let asked=false;
      try{
        if(options.ready()){
          asked=true;
          controller=new AbortController();
          const response=await fetchImpl(options.url(),{headers:options.headers(),signal:controller.signal,redirect:"error"});
          if(response.ok&&response.body){
            delay=5000;onChange({});
            const decoder=new TextDecoder();let buffer="";
            for await(const chunk of response.body){
              buffer+=decoder.decode(chunk,{stream:true});
              let end;
              while((end=buffer.indexOf("\n\n"))>=0){
                const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
                // NOTIFY-EVERYWHERE-1019 S3: with onFrame, three more kinds are delivered as ids only (attention.settled, bot, config).
                // A block is parsed only when it carries one of these markers, so a busy stream costs nothing extra.
                if(!block.includes("inbox.changed")&&!(options.onFrame&&FRAME_MARKERS.some(marker=>block.includes(marker))))continue;
                const data=block.split("\n").find(line=>line.startsWith("data: "));
                try{
                  const frame=JSON.parse(data.slice(6));
                  if(frame.kind==="inbox.changed")onChange({scale:frame.pollScale});
                  else if(options.onFrame){
                    const id=value=>typeof value==="string"&&value?value:null;
                    if(frame.kind==="attention.settled"&&id(frame.threadId)&&id(frame.requestId))options.onFrame({kind:"attention.settled",threadId:frame.threadId,requestId:frame.requestId});
                    else if(frame.kind==="bot"&&id(frame.bot?.id))options.onFrame({kind:"bot",botId:frame.bot.id});
                    else if(frame.kind==="config")options.onFrame({kind:"config"});
                  }
                }catch{}
              }
              // Only an unfinished frame is left here. A huge one (a long
              // message) is not ours: keep its tail so the boundary is found.
              // Capped AFTER the complete frames are read, so a notice in the
              // same read as a big frame is never cut away.
              if(buffer.length>1048576)buffer=buffer.slice(-65536);
            }
          }
        }
      }catch{}
      if(stopped)return;
      // Back off only after the server was asked and failed; while it is still
      // starting (or restarting) keep checking every 5 s, or the tray would
      // spend its first minute on the slow fallback.
      if(!asked){await pause(5000);continue;}
      await pause(delay);delay=Math.min(60000,delay*2);
    }
  })();
  return()=>{stopped=true;try{controller?.abort();}catch{}if(timer)cancel(timer);};
}
