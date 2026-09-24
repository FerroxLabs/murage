/** Main-process background policy. Native effects are injected so tests never
 * modify the owner's OS login settings or borrow an existing app window. */
export function backgroundPreferences(value, platform) {
  return {
    keepRunning: typeof value?.keepRunning === "boolean" ? value.keepRunning : platform === "darwin",
    explicit: typeof value?.keepRunning === "boolean",
    closeExplained: value?.closeExplained === true,
  };
}

export function createBackgroundLifecycle(options) {
  let preferences=backgroundPreferences(options.loadPreferences(),options.platform);
  let tray=null,trayAvailable=false,quitting=false,suspended=false,automationsPaused=null,closePending=null,monitor=null;
  let probing=false,disposed=false;
  const alive=()=>{const win=options.window();return win&&!win.isDestroyed()?win:null;};
  const canReopen=()=>trayAvailable||options.dockAvailable?.()===true;
  const shuttingDown=()=>quitting||options.isQuitting?.()===true;
  const loginState=()=>{
    try{return options.login.read();}catch{return {supported:false,openAtLogin:false,reason:"Sign-in settings could not be read."};}
  };
  const status=()=>({platform:options.platform,keepRunning:preferences.keepRunning,defaultInherited:!preferences.explicit,configurable:options.preferencesWritable?.()!==false,trayAvailable,canKeepRunning:canReopen(),
    effectiveKeepRunning:preferences.keepRunning&&canReopen()&&!shuttingDown(),windowVisible:alive()?.isVisible()===true,
    suspended,quitting:shuttingDown(),automationsPaused,login:loginState()});
  const notify=()=>options.onChange?.(status());
  const report=error=>options.onError?.(error instanceof Error?error:new Error(String(error)));
  const open=()=>{options.openWindow();notify();};
  let summary=null;
  const openTarget=target=>{open();options.openTarget?.(target);};
  const answer=async(item,behavior)=>{
    // Re-read first: the card must still be waiting, still the same request
    // and still one the menu may answer. The answer then goes through the
    // same route and checks as the app's own Allow and Deny buttons.
    const current=await options.harness.get("/api/desktop/tray");
    const live=current?.items?.find(entry=>entry.messageId===item.messageId&&entry.threadId===item.threadId);
    if(!live||!live.quick||live.requestId!==item.requestId)throw new Error("That approval changed. Open it in Murage to answer.");
    await options.harness.post(`/api/threads/${encodeURIComponent(item.threadId)}/respond`,{requestId:item.requestId,behavior});
  };
  const decide=(item,behavior)=>()=>void answer(item,behavior).catch(error=>{report(error);openTarget({kind:"approval",botId:item.botId,threadId:item.threadId,messageId:item.messageId});}).finally(()=>void refresh().catch(report));
  const menu=()=>trayMenu({summary,automationsPaused,now:(options.now??Date.now)(),
    open,openInbox:()=>{open();options.openInbox();},openTarget,decide,
    togglePause:()=>{
      const paused=!automationsPaused;
      void options.setAutomationsPaused(paused).then(result=>{automationsPaused=result.paused;refreshMenu();notify();}).catch(report);
    },
    checkForUpdates:options.checkForUpdates?()=>{open();options.checkForUpdates();}:null,
    quit:()=>{quitting=true;options.quit();}});
  const refreshMenu=()=>{if(!tray||tray.isDestroyed())return;options.setTrayMenu(tray,menu());try{options.presentTray?.(tray,trayPresentation(summary?.needsYou,options.platform));}catch(error){report(error);}};
  const refresh=async()=>{
    if(probing)return;probing=true;
    try{
      const candidate=tray;
      const available=Boolean(candidate&&!candidate.isDestroyed()&&await Promise.resolve().then(()=>options.probeTray(candidate)).catch(()=>false));
      if(disposed)return;
      trayAvailable=available&&tray===candidate&&!candidate.isDestroyed();
      if(!canReopen()&&alive()&&!alive().isVisible()&&!shuttingDown())open();
      try{automationsPaused=(await options.automationStatus()).paused;}catch{automationsPaused=null;}
      // A failed read shows nothing rather than a stale count.
      if(options.harness){try{summary=traySummaryValue(await options.harness.get("/api/desktop/tray"));}catch{summary=null;}}
      refreshMenu();notify();
    }finally{probing=false;}
  };
  return {
    status,open,
    async start(){
      disposed=false;
      try{tray=options.createTray(open);refreshMenu();}catch(error){tray=null;report(error);}
      await refresh();
      if(disposed)return status();
      monitor=(options.setInterval??setInterval)(()=>void refresh().catch(report),5000);monitor?.unref?.();
      return status();
    },
    refresh,
    summary:()=>summary,
    async update(patch){
      if(shuttingDown())throw new Error("Murage is closing. Startup settings were not changed.");
      const entries=patch&&typeof patch==="object"&&!Array.isArray(patch)?Object.entries(patch):[];
      if(entries.length!==1||!["keepRunning","startAtLogin"].includes(entries[0][0])||typeof entries[0][1]!=="boolean")throw new Error("Change one startup setting at a time.");
      const [key,value]=entries[0];
      if(key==="keepRunning"){
        if(options.preferencesWritable?.()===false)throw new Error("Open the installed Murage app to change startup preferences.");
        if(value&&!canReopen())throw new Error("No working tray or Dock entry is available. Keep the window open to use Murage.");
        const next={...preferences,keepRunning:value,explicit:true};
        options.savePreferences({keepRunning:next.keepRunning,closeExplained:next.closeExplained});preferences=next;
        if(!value&&alive()&&!alive().isVisible())open();
      }else{
        if(!loginState().supported)throw new Error(loginState().reason??"Sign-in startup is unavailable for this installation.");
        await options.login.write(value);
        const actual=loginState();
        if(actual.openAtLogin!==value&&!actual.requiresApproval)throw new Error("The operating system did not confirm the sign-in setting.");
      }
      notify();return status();
    },
    shouldStartQuietly(){return preferences.keepRunning&&trayAvailable&&!shuttingDown()&&options.serviceReady?.()!==false;},
    handleClose(event){
      if(shuttingDown()||!preferences.keepRunning||!canReopen())return false;
      event.preventDefault();
      if(closePending)return true;
      closePending=(async()=>{
        if(!preferences.closeExplained){
          const choice=await options.explainClose(alive());
          if(shuttingDown())return;
          options.savePreferences({...(preferences.explicit?{keepRunning:preferences.keepRunning}:{}),closeExplained:true});
          preferences={...preferences,closeExplained:true};
          if(choice==="quit"){quitting=true;options.quit();return;}
        }
        if(shuttingDown())return;
        if(preferences.keepRunning&&canReopen())alive()?.hide();else open();
        notify();
      })().catch(error=>{open();report(error);}).finally(()=>{closePending=null;});
      return true;
    },
    settledClose(){return closePending??Promise.resolve();},
    keepAliveWithoutWindows(){return preferences.keepRunning&&canReopen()&&!shuttingDown();},
    beginQuit(){quitting=true;notify();},
    setSuspended(value){suspended=value;notify();if(!value)void refresh().catch(report);},
    dispose(){disposed=true;if(monitor)(options.clearInterval??clearInterval)(monitor);monitor=null;if(tray&&!tray.isDestroyed())tray.destroy();tray=null;trayAvailable=false;},
  };
}

const MENU_LABEL_MAX=44;
const clip=(text,max=MENU_LABEL_MAX)=>{const value=String(text??"").replace(/\s+/g," ").trim();return value.length>max?`${value.slice(0,max-1).trimEnd()}…`:value;};
/** Only the shape the menu reads; anything else is treated as no data. */
export function traySummaryValue(value){
  if(!value||typeof value!=="object"||!Number.isSafeInteger(value.needsYou)||value.needsYou<0||!Array.isArray(value.items))return null;
  const text=entry=>typeof entry==="string"?entry:"";
  return {needsYou:value.needsYou,
    items:value.items.filter(item=>item&&typeof item.threadId==="string"&&typeof item.messageId==="string").map(item=>({botId:typeof item.botId==="string"?item.botId:undefined,botName:text(item.botName)||"Murage",summary:text(item.summary),threadId:item.threadId,messageId:item.messageId,requestId:typeof item.requestId==="string"?item.requestId:undefined,quick:item.quick===true&&typeof item.requestId==="string"})),
    working:(Array.isArray(value.working)?value.working:[]).filter(item=>item&&typeof item.botId==="string"&&typeof item.threadId==="string").map(item=>({botId:item.botId,botName:text(item.botName),threadId:item.threadId,doing:text(item.doing)||"Working",startedAt:Number.isFinite(item.startedAt)?item.startedAt:undefined})),
    bots:(Array.isArray(value.bots)?value.bots:[]).filter(bot=>bot&&typeof bot.id==="string").map(bot=>({id:bot.id,name:text(bot.name),chief:bot.chief===true})),
    moreBots:value.moreBots===true};
}
/** Count on the tray itself: a title beside the macOS template glyph (which
 * cannot be coloured), the dotted icon on Windows and Linux. */
export function trayPresentation(count,platform){
  const n=Number.isSafeInteger(count)&&count>0?count:0;
  return {attention:n>0,title:platform==="darwin"&&n>0?` ${n>99?"99+":n}`:"",tooltip:n>0?`Murage: ${n} need${n===1?"s":""} you`:"Murage"};
}
export function elapsedLabel(startedAt,now){
  if(!Number.isFinite(startedAt))return "";
  const seconds=Math.max(0,Math.round((now-startedAt)/1000));
  if(seconds<60)return `${seconds} s`;
  const minutes=Math.floor(seconds/60);
  if(minutes<60)return `${minutes} min`;
  return `${Math.floor(minutes/60)} h ${minutes%60} min`;
}
/** The tray menu, top to bottom: what needs the owner, what is running,
 * who to write to, then the app itself. Plain words; no em dashes. */
export function trayMenu({summary,automationsPaused,now,open,openInbox,openTarget,decide,togglePause,checkForUpdates,quit}){
  const items=[];
  const count=summary?.needsYou??0;
  if(count>0){
    items.push({label:`Needs you  ${count}`,enabled:false});
    for(const item of summary.items){
      const label=clip(`${item.botName} · ${item.summary||"Waiting on you"}`);
      const target={kind:"approval",botId:item.botId,threadId:item.threadId,messageId:item.messageId};
      // Stop-line, keys and secrets, and anything else the server marks as
      // needing the full card are opened, never answered from here.
      if(item.quick)items.push({label,submenu:[
        {label:clip(item.summary,240),enabled:false},{type:"separator"},
        {label:"Open",click:()=>openTarget(target)},
        {label:"Allow once",click:decide(item,"allow")},
        {label:"Deny",click:decide(item,"deny")},
      ]});
      else items.push({label,click:()=>openTarget(target)});
    }
  }
  items.push({label:"See all in Inbox",click:openInbox},{type:"separator"});
  if(summary?.working?.length){
    items.push({label:"Working now",enabled:false});
    for(const run of summary.working)items.push({label:clip([run.botName,run.doing,elapsedLabel(run.startedAt,now)].filter(Boolean).join(" · "),60),click:()=>openTarget({kind:"conversation",botId:run.botId,threadId:run.threadId})});
    items.push({type:"separator"});
  }
  if(summary?.bots?.length){
    const bots=summary.bots.map(bot=>({label:clip(bot.name,40),click:()=>openTarget({kind:"compose",botId:bot.id})}));
    if(summary.bots[0].chief&&bots.length>1)bots.splice(1,0,{type:"separator"});
    if(summary.moreBots)bots.push({type:"separator"},{label:"More in Murage",click:open});
    items.push({label:"New message to…",submenu:bots});
  }
  items.push({label:"Open Murage",click:open},{type:"separator"},
    {label:automationsPaused===null?"Pause automations (unavailable)":automationsPaused?"Resume automations":"Pause automations",enabled:automationsPaused!==null,click:togglePause},
    ...(checkForUpdates?[{label:"Check for updates",click:checkForUpdates}]:[]),
    {type:"separator"},
    {label:"Quit Murage",click:quit});
  return items;
}

/** Electron exposes no Linux tray bounds. Require a live registered host;
 * missing gdbus/session support degrades to keeping the window visible. */
export function linuxTrayHostAvailable(execFile){
  return new Promise(resolve=>execFile("/usr/bin/gdbus",["call","--session","--dest","org.kde.StatusNotifierWatcher","--object-path","/StatusNotifierWatcher","--method","org.freedesktop.DBus.Properties.Get","org.kde.StatusNotifierWatcher","IsStatusNotifierHostRegistered"],{timeout:1500,windowsHide:true},(error,stdout)=>resolve(!error&&/\btrue\b/.test(String(stdout)))));
}
