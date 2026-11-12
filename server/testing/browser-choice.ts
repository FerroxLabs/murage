/** Isolated HTTP test helper: read the owner's current choice, review the exact
 * destination, then submit the returned revision and disclosure key. */
export async function confirmedBrowserFields(url:string,headers:Record<string,string>,path:string,body:Record<string,any>){
 const current=await(await fetch(url+path,{headers})).json() as {bot?:{useMyChrome?:boolean;browserTransport?:string;browserExtensionBrowser?:string}};
 const bot=current.bot??{},own=body.useMyChrome===false||(!body.useMyChrome&&!bot.useMyChrome);
 const route=body.browserTransport==='extension'||(body.browserTransport===undefined&&bot.browserTransport==='extension')?'chrome-extension':'chrome-direct';
 const q=new URLSearchParams({mode:own?'builtin':body.browserTransport==='auto'?'your-chrome':route});
 const profile=body.browserExtensionProfileId??body.browserProfile;if(profile)q.set('profile',profile);const browser=body.browserExtensionBrowser??bot.browserExtensionBrowser;if(browser)q.set('browser',browser);
 const preview=await(await fetch(url+path+'/browser-choice/preview?'+q,{headers})).json() as {baseRevision:number;disclosure:{disclosureKey:string}};
 return {...body,baseRevision:preview.baseRevision,disclosureKey:preview.disclosure.disclosureKey};
}
