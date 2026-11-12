import { browserCopy, renderBrowserCopy, type BrowserCopy } from '../shared/browser-copy.ts';
import { createHash } from 'node:crypto';
export type BrowserMode = 'builtin' | 'chrome-extension' | 'chrome-direct';
export type BrowserSelection = { mode: BrowserMode; profile?: string; browser?: 'chrome' | 'edge' | 'brave' };
export type BrowserDestination = BrowserSelection & { botName: string; profileKind: 'own' | 'named' | 'guest' | 'chrome'; profileLabel: string; sharedWith: string[]; mayBeSignedIn: boolean; accounts: string; presentation: 'panel' | 'window' };
export type TurnBrowser = BrowserDestination & { revision: number; readiness: { kind: 'ready' | 'setup_needed' | 'unavailable' | 'waiting'; cause?: string } };
export type DestinationContext = { profiles?: readonly {id:string;name:string}[]; bots?: readonly {id:string;name:string;browserProfile?:string;browserMode?:BrowserMode;useMyChrome?:boolean}[]; chromeProfiles?: readonly {profileId:string;browser?:string;name?:string}[] };
export function browserGuardSet(mode: BrowserMode) {
  return { floor:true, documentGuard:mode !== 'chrome-extension', siteScope:mode === 'chrome-extension', askLevels:mode === 'chrome-extension', actionCheck:mode === 'chrome-extension', ownerLogins:mode !== 'builtin', tabScope:mode === 'chrome-direct' };
}
export function canMoveAutomatically(from: BrowserMode, to: BrowserMode) { return from === to; }
export function proposeYourChromeRoute(bot: {browserExtensionBrowser?: string}, profiles: readonly {profileId:string;browser?:string}[]): 'chrome-extension' | 'chrome-direct' {
  return profiles.some(p=>p.browser?.toLowerCase() === (bot.browserExtensionBrowser ?? 'chrome')) ? 'chrome-extension' : 'chrome-direct';
}
/** An unspecified extension profile may resolve only within the chosen browser.
 * A generic Chromium hello cannot identify Chrome versus Edge or Brave. */
export function extensionProfileForChoice(choice:{profile?:string;browser?:string},profiles:readonly {profileId:string;browser?:string}[]):string|undefined{
  if(choice.profile)return choice.profile;
  const matches=profiles.filter(p=>p.browser?.toLowerCase()===(choice.browser??'chrome'));
  return matches.length===1?matches[0].profileId:undefined;
}
export function resolveBrowserDestination(bot: {id:string;name:string}, choice: BrowserSelection, context: DestinationContext = {}): BrowserDestination {
  choice={...choice,profile:choice.mode==='chrome-direct'?undefined:choice.profile,browser:choice.mode==='chrome-direct'?'chrome':choice.mode==='builtin'?undefined:choice.browser};
  if(choice.mode==='chrome-extension')choice={...choice,profile:extensionProfileForChoice(choice,context.chromeProfiles??[])};
  const chrome = choice.mode !== 'builtin', guest = !chrome && choice.profile === 'guest';
  const named = !chrome && !!choice.profile && !guest;
  const chromeProfile = context.chromeProfiles?.find(p=>p.profileId === choice.profile);
  return { mode:choice.mode, profile:choice.profile, browser:choice.browser, botName:bot.name, profileKind: chrome ? 'chrome' : guest ? 'guest' : named ? 'named' : 'own',
    profileLabel: chrome ? chromeProfile?.name ?? choice.profile ?? 'Your Chrome' : guest ? 'Guest' : named ? context.profiles?.find(p=>p.id === choice.profile)?.name ?? choice.profile! : `${bot.name}'s own`,
    sharedWith: named ? (context.bots ?? []).filter(b=>b.id !== bot.id && b.browserProfile === choice.profile && (b.browserMode==='builtin'||(!b.browserMode&&!b.useMyChrome))).map(b=>b.name).sort() : [],
    mayBeSignedIn:!guest, accounts:chrome ? 'yours' : named ? "the profile's" : `${bot.name}'s`, presentation:'panel' };
}
export function guardLoosened(from: BrowserMode, to: BrowserMode) {
  const a=browserGuardSet(from),b=browserGuardSet(to);
  return (Object.keys(a) as (keyof typeof a)[]).some(k=>k !== 'ownerLogins' && a[k] && !b[k]) || (!a.ownerLogins && b.ownerLogins);
}
export function ownerMoveDisclosure(from: BrowserSelection & {revision:number}, destination: BrowserDestination, approval: 'step'|'task'|'full' = 'task') {
  const copy:BrowserCopy[]=[];
  if(approval === 'step' && (destination.mode === 'chrome-direct' || (from.mode === 'chrome-extension' && destination.mode !== from.mode))) copy.push({key:'browser.disclosure.step',values:{name:destination.botName}});
  copy.push({key:'browser.disclosure.destination',values:{name:destination.botName,browser:browserCopy(destination.mode==='builtin'?'browser.disclosure.own':'browser.disclosure.chrome'),profile:destination.profileLabel,shared:destination.sharedWith.length?browserCopy('browser.disclosure.shared',{names:destination.sharedWith.join(' and ')}):'',application:destination.mode!=='builtin'?browserCopy('browser.disclosure.application',{browser:destination.browser==='edge'?'Edge':destination.browser==='brave'?'Brave':'Chrome'}):'',accounts:browserCopy(destination.mayBeSignedIn?'browser.disclosure.signedIn':'browser.disclosure.guest')}});
  if(from.mode === 'chrome-extension' && destination.mode !== from.mode) copy.push({key:'browser.disclosure.floor'});
  else if(destination.mode !== 'builtin') copy.push({key:destination.mode === 'chrome-direct'?'browser.disclosure.direct':'browser.disclosure.extension'});
  const destinationCopy=copy.find(item=>item.key==='browser.disclosure.destination')!;
  destinationCopy.parts={browser:{key:destination.mode==='builtin'?'browser.disclosure.own':'browser.disclosure.chrome'},accounts:{key:destination.mayBeSignedIn?'browser.disclosure.signedIn':'browser.disclosure.guest'}};
  if(destination.sharedWith.length)destinationCopy.parts.shared={key:'browser.disclosure.shared',values:{names:destination.sharedWith.join(', ')}};
  if(destination.mode!=='builtin')destinationCopy.parts.application={key:'browser.disclosure.application',values:{browser:destination.browser==='edge'?'Edge':destination.browser==='brave'?'Brave':'Chrome'}};
  if(destination.profileKind==='own')destinationCopy.parts.profile={key:'browser.ownProfile',values:{name:destination.botName}};
  else if(destination.profileKind==='guest')destinationCopy.parts.profile={key:'browser.guest'};
  else if(destination.profileKind==='chrome'&&destination.profileLabel==='Your Chrome')destinationCopy.parts.profile={key:'browser.yourChrome'};
  const lines=copy.map(item=>renderBrowserCopy(item));
  lines[lines.length-1]+=' '+browserCopy('browser.disclosure.back');
  const disclosureKey=createHash('sha256').update(JSON.stringify({from,destination,approval})).digest('hex');
  return {lines,copy,disclosureKey};
}
export function browserTurnContext(turn: TurnBrowser): string {
  if(turn.readiness.kind !== 'ready') return `This turn's browser is not connected: ${turn.readiness.cause ?? 'Finish setup'}. Do not use another browser or account to bypass this.`;
  return `This turn's browser: ${turn.mode}, profile ${turn.profileLabel}${turn.sharedWith.length ? ` (shared with ${turn.sharedWith.join(', ')})` : ''}. ${turn.mayBeSignedIn ? `Sites may already be signed in from earlier sessions; those accounts are ${turn.accounts}.` : 'Guest starts empty; nothing is kept.'} Do not sign out, change account settings, or act as that account beyond what the task asks.${turn.presentation === 'window' ? ' The owner has this browser in a Chrome window; you are paused.' : ''}`;
}
