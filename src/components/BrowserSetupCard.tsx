// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { api, type Bot, type Message } from "@/state/store";
import { readBrowserSetupCard, type BrowserSetupCardData } from "../../shared/browser-setup-card";
const control = "browser-extension-control min-h-11 rounded-lg bg-control px-3 py-2 text-sm text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent";
type Browser = "chrome" | "edge" | "brave";
const BROWSER_NAMES: Record<Browser, string> = { chrome: "Chrome", edge: "Edge", brave: "Brave" };
type Profile = { profileId: string; browser: string };
type ViewProps = { bot: Bot; subtitle?: string; setup: BrowserSetupCardData; profiles: Profile[]; profile: string; pending: boolean; browser: Browser; error: string;
  storeUrl: string | null; extensionBuild?: "release" | "development" | "none"; onBrowser: (browser: Browser) => void; onProfile: (profileId: string) => void; onAct: (action: "accept" | "decline" | "continue") => void };
export function BrowserSetupCardView({ bot, subtitle, setup, profiles, profile, pending, browser, error, storeUrl, extensionBuild, onBrowser, onProfile, onAct }: ViewProps) {
  // A bot connected before keeps its profile: the card names that browser and
  // offers a choice only when a different profile is the one online.
  const remembered = !!setup.profileId && setup.decision === "accepted";
  const rememberedConnected = remembered && profiles.some(item => item.profileId === setup.profileId);
  const rememberedName = setup.browser ? BROWSER_NAMES[setup.browser] : "browser";
  // A release build whose listing is not public yet, or a copy without the
  // helper, has nothing to set up: say so and keep Not now.
  const unavailable = extensionBuild === "none" ? "This copy of Murage is not set up for Murage for Chrome yet." : extensionBuild === "release" && !storeUrl ? "Murage for Chrome is not in the Chrome Web Store yet." : "";
  return <section aria-label="Optional browser setup" className="flex max-w-full flex-col gap-3 rounded-xl border border-hairline bg-card p-4 text-sm text-ink">
    <h3 className="font-medium">Use your browser for this task?</h3>
    <p className="text-ink-secondary">{subtitle}</p>
    {!setup.decision && <>
      <p>{bot.name} can use tabs you share, signed in as you. You choose each site's access, and actions that send, post or change something need separate approval.</p>
      <p>Set up also enables browser tools in this workspace.</p>
      <p className="text-ink-secondary">This is optional. Your request stays in this conversation if you choose not to connect.</p>
      {unavailable && <p role="status">{unavailable} Choose Not now to continue without it.</p>}
      <label className="flex flex-col gap-2">Browser to connect<select className={control} value={browser} disabled={pending || !!unavailable} onChange={event=>onBrowser(event.target.value as Browser)}><option value="chrome">Chrome</option><option value="edge">Edge</option><option value="brave">Brave</option></select></label>
      <div className="flex flex-wrap gap-2"><button className={control} disabled={pending || !!unavailable} onClick={()=>onAct("accept")}>Set up my browser</button><button className={control} disabled={pending} onClick={()=>onAct("decline")}>Not now</button></div>
    </>}
    {setup.decision==="accepted"&&!setup.resumed&&<>
      {storeUrl ? <>
        <p>Add Murage for Chrome from the Chrome Web Store. Your browser asks you to confirm the install. Then open its side panel to connect.</p>
        <a className={`${control} text-center`} href={storeUrl} target="_blank" rel="noopener noreferrer">Open Chrome Web Store</a>
      </> : unavailable ? <p>{unavailable}</p> : extensionBuild === "development" ? <p>Open Murage for Chrome and connect its helper. This build uses an unpacked development extension. A store listing is not published yet.</p> : <p>Open Murage for Chrome and connect its helper.</p>}
      <p className="text-ink-secondary">Share a tab in the extension. If it is paused or stopped, check the page and resume there first.</p>
      {remembered ? <p role="status">{rememberedConnected?`Your ${rememberedName} profile for ${bot.name} is connected. Choose Continue when you are ready.`:`Waiting for your ${rememberedName} profile for ${bot.name}. Open ${rememberedName} with Murage for Chrome. Your task has not restarted.`}</p>
        : <p role="status">{profiles.length?"A browser profile is connected. Choose Continue when you are ready.":"Waiting for a connected browser profile. Your task has not restarted."}</p>}
      {(remembered ? !rememberedConnected && profiles.length>0 : profiles.length>1)&&<label className="flex flex-col gap-2">Browser profile<select className={control} value={profile||setup.profileId||""} onChange={event=>onProfile(event.target.value)}><option value="" disabled>Choose a profile</option>{profiles.map(item=><option key={item.profileId} value={item.profileId}>{item.browser} · {item.profileId.slice(0,8)}</option>)}</select></label>}
      <div className="flex flex-wrap gap-2"><button className={control} disabled={pending||!!setup.continueRequested} onClick={()=>onAct("continue")}>{setup.continueRequested?"Waiting for this turn to finish…":"Check connection and continue"}</button>
        {setup.remembered&&!setup.continueRequested&&<button className={control} disabled={pending} onClick={()=>onAct("decline")}>Not now</button>}</div>
    </>}
    {(setup.resumed||setup.decision==="declined")&&<p role="status" className="text-ink-secondary">{setup.decision==="declined"?"You chose not to connect. The task can continue without browser access.":"Connection checked. The original request was handed back to the bot."}</p>}
    {(error||setup.error)&&<p role="alert" className="text-danger">{error||setup.error}</p>}
  </section>;
}
export function BrowserSetupCard({ bot, message }: { bot: Bot; message: Message }) {
  const original = readBrowserSetupCard(message.card);
  const [setup, setSetup] = useState<BrowserSetupCardData | null>(original);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [listing, setListing] = useState<{ storeUrl: string | null; extensionBuild?: "release" | "development" | "none" }>({ storeUrl: null });
  const [profile, setProfile] = useState("");
  const [pending, setPending] = useState(false);
  const [browser, setBrowser] = useState<Browser>(bot.browserExtensionBrowser ?? original?.browser ?? "chrome");
  const [error, setError] = useState("");
  const base = original ? `/api/threads/${encodeURIComponent(original.threadId)}/browser-setup/${encodeURIComponent(message.id)}` : "";
  useEffect(() => {
    if (!base) return;
    let alive=true;let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{try{const result=await api(base);if(alive){setSetup(result.setup);setProfiles(result.profiles);setListing({storeUrl:result.storeUrl??null,extensionBuild:result.extensionBuild});}}catch{/* Owner actions display their error. A companion without authority cannot change this card. */}finally{if(alive)timer=setTimeout(load,2500);}};
    void load();return()=>{alive=false;clearTimeout(timer);};
  },[base]);
  if(!setup)return null;
  const act=async(action:"accept"|"decline"|"continue")=>{
    setPending(true);setError("");
    try{const result=await api(base,{method:"POST",body:JSON.stringify({action,...(action==="accept"?{browser}:{}),...(action==="continue"?{profileId:profile||setup.profileId||(profiles.length===1?profiles[0].profileId:undefined)}:{})})});setSetup(result.setup);setProfiles(result.profiles);setListing({storeUrl:result.storeUrl??null,extensionBuild:result.extensionBuild});}
    catch(cause){setError(cause instanceof Error?cause.message:"Browser setup could not update. Try again.");}finally{setPending(false);}
  };
  return <BrowserSetupCardView bot={bot} subtitle={message.card?.subtitle} setup={setup} profiles={profiles} profile={profile} pending={pending} browser={browser} error={error}
    storeUrl={listing.storeUrl} extensionBuild={listing.extensionBuild} onBrowser={setBrowser} onProfile={setProfile} onAct={action=>void act(action)} />;
}
