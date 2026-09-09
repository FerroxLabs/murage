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
  const menu=()=>[
    {label:"Open Murage",click:open},
    {label:"Inbox",click:()=>{open();options.openInbox();}},
    {type:"separator"},
    {label:automationsPaused===null?"Pause automations (unavailable)":automationsPaused?"Resume automations":"Pause automations",enabled:automationsPaused!==null,click:()=>{
      const paused=!automationsPaused;
      void options.setAutomationsPaused(paused).then(result=>{automationsPaused=result.paused;refreshMenu();notify();}).catch(report);
    }},
    {type:"separator"},
    {label:"Quit Murage",click:()=>{quitting=true;options.quit();}},
  ];
  const refreshMenu=()=>{if(tray&&!tray.isDestroyed())options.setTrayMenu(tray,menu());};
  const refresh=async()=>{
    if(probing)return;probing=true;
    try{
      const candidate=tray;
      const available=Boolean(candidate&&!candidate.isDestroyed()&&await Promise.resolve().then(()=>options.probeTray(candidate)).catch(()=>false));
      if(disposed)return;
      trayAvailable=available&&tray===candidate&&!candidate.isDestroyed();
      if(!canReopen()&&alive()&&!alive().isVisible()&&!shuttingDown())open();
      try{automationsPaused=(await options.automationStatus()).paused;}catch{automationsPaused=null;}
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

/** Electron exposes no Linux tray bounds. Require a live registered host;
 * missing gdbus/session support degrades to keeping the window visible. */
export function linuxTrayHostAvailable(execFile){
  return new Promise(resolve=>execFile("/usr/bin/gdbus",["call","--session","--dest","org.kde.StatusNotifierWatcher","--object-path","/StatusNotifierWatcher","--method","org.freedesktop.DBus.Properties.Get","org.kde.StatusNotifierWatcher","IsStatusNotifierHostRegistered"],{timeout:1500,windowsHide:true},(error,stdout)=>resolve(!error&&/\btrue\b/.test(String(stdout)))));
}
