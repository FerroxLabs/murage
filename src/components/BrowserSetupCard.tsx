import { BrowserDisclosure } from './BrowserDisclosure';
import { t } from '@/lib/i18n';
import { BrowserPreflight } from './BrowserPreflight';
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
  const rememberedName = setup.browser ? BROWSER_NAMES[setup.browser] : t('browser.browserName');
  // Install copy is for a browser with nothing connected yet. Once a profile
  // is online the extension is plainly installed, so the store link would
  // only send the owner to install it twice.
  const anyConnected = rememberedConnected || profiles.length > 0;
  // A copy without the helper has nothing to set up: say so and keep Not now.
  // A release build without a store link can still be set up, for an
  // extension that is already installed, so it stays enabled.
  const direct = setup.browserChoice?.mode === "chrome-direct" || setup.selectedMode === "chrome-direct";
  const unavailable = !direct && extensionBuild === "none" ? t('browser.extensionUnavailable') : "";
  const installedOnly = !direct && extensionBuild === "release" && !storeUrl;
  return <section aria-label={t("browser.BrowserSetupCard.1")} className="flex max-w-full flex-col gap-3 rounded-xl border border-hairline bg-card p-4 text-sm text-ink">
    <h3 className="font-medium">{t('browser.yourchrome.ask',{name:bot.name})}</h3>
    <p className="text-ink-secondary">{subtitle}</p>
    {setup.decision!=="declined"&&!setup.resumed&&<BrowserPreflight botId={bot.id} route={direct?"chrome-direct":"chrome-extension"} browser={direct?"chrome":browser}/> }
    {!setup.decision && <>
      {setup.browserChoice&&<BrowserDisclosure {...setup.browserChoice}/>}
      {direct ? <p>{t('browser.directScope',{name:bot.name})}</p> : <p>{t('browser.extensionScope',{name:bot.name})}</p>}
      <p>{t("browser.BrowserSetupCard.2")}</p>
      <p className="text-ink-secondary">{t("browser.BrowserSetupCard.3")}</p>
      {unavailable && <p role="status">{unavailable} {t('browser.continueWithout')}</p>}
      {installedOnly && <p role="status">{t("browser.BrowserSetupCard.4")}</p>}
      {!setup.browserChoice&&<label className="flex flex-col gap-2">{t("browser.BrowserSetupCard.5")}<select className={control} value={browser} disabled={pending || !!unavailable} onChange={event=>onBrowser(event.target.value as Browser)}><option value="chrome">{t("browser.BrowserSetupCard.6")}</option><option value="edge">{t("browser.BrowserSetupCard.7")}</option><option value="brave">{t("browser.BrowserSetupCard.8")}</option></select></label>}
      <div className="flex flex-wrap gap-2"><button className={control} disabled={pending || !!unavailable} onClick={()=>onAct("accept")}>{setup.browserChoice?t('browser.useChrome'):t('browser.setUp')}</button><button className={control} disabled={pending} onClick={()=>onAct("decline")}>{t("browser.BrowserSetupCard.9")}</button></div>
    </>}
    {setup.decision==='accepted'&&setup.selectedMode==='chrome-direct'&&!setup.resumed&&<><p>{t("browser.BrowserSetupCard.10")}</p><button className={control} disabled={pending} onClick={()=>onAct('continue')}>{t("browser.BrowserSetupCard.11")}</button></>}
    {setup.decision==="accepted"&&setup.selectedMode!=='chrome-direct'&&!setup.resumed&&<>
      {anyConnected ? null : storeUrl ? <>
        <p>{t("browser.BrowserSetupCard.12")}</p>
        <a className={`${control} text-center`} href={storeUrl} target="_blank" rel="noopener noreferrer">{t("browser.BrowserSetupCard.13")}</a>
      </> : unavailable ? <p>{unavailable}</p> : extensionBuild === "development" ? <p>{t("browser.BrowserSetupCard.14")}</p> : <p>{t("browser.BrowserSetupCard.15")}</p>}
      <p className="text-ink-secondary">{t("browser.BrowserSetupCard.16")}</p>
      {remembered ? <p role="status">{rememberedConnected?t('browser.profileReady',{browser:rememberedName,name:bot.name}):t('browser.profileWaiting',{browser:rememberedName,name:bot.name})}</p>
        : <p role="status">{profiles.length?t('browser.connectedContinue'):t('browser.waitingProfile')}</p>}
      {(remembered ? !rememberedConnected && profiles.length>0 : profiles.length>1)&&<label className="flex flex-col gap-2">{t("browser.BrowserSetupCard.17")}<select className={control} value={profile||setup.profileId||""} onChange={event=>onProfile(event.target.value)}><option value="" disabled>{t("browser.BrowserSetupCard.18")}</option>{profiles.map(item=><option key={item.profileId} value={item.profileId}>{item.browser} · {item.profileId.slice(0,8)}</option>)}</select></label>}
      <div className="flex flex-wrap gap-2"><button className={control} disabled={pending||!!setup.continueRequested} onClick={()=>onAct("continue")}>{setup.continueRequested?t('browser.waitingTurn'):t('browser.checkContinue')}</button>
        {setup.remembered&&!setup.continueRequested&&<button className={control} disabled={pending} onClick={()=>onAct("decline")}>{t("browser.BrowserSetupCard.19")}</button>}</div>
    </>}
    {(setup.resumed||setup.decision==="declined")&&<p role="status" className="text-ink-secondary">{setup.decision==="declined"?t('browser.declined'):t('browser.continued')}</p>}
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
    catch(cause){setError(cause instanceof Error?cause.message:t('browser.setupRetry'));}finally{setPending(false);}
  };
  return <BrowserSetupCardView bot={bot} subtitle={message.card?.subtitle} setup={setup} profiles={profiles} profile={profile} pending={pending} browser={browser} error={error}
    storeUrl={listing.storeUrl} extensionBuild={listing.extensionBuild} onBrowser={setBrowser} onProfile={setProfile} onAct={action=>void act(action)} />;
}
