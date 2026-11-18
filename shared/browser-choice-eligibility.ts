import { browserCopy } from './browser-copy.ts';
const failures={
  "browser_release_failed": {
    "messageKey": "browser.cause.browser_release_failed.message",
    "actionKey": "browser.cause.browser_release_failed.action"
  },
  "browser_extension_setup_required": {
    "messageKey": "browser.cause.browser_extension_setup_required.message",
    "actionKey": "browser.cause.browser_extension_setup_required.action"
  },
  "host_offline": {
    "messageKey": "browser.cause.host_offline.message",
    "actionKey": "browser.cause.host_offline.action"
  },
  "incompatible_capabilities": {
    "messageKey": "browser.cause.incompatible_capabilities.message",
    "actionKey": "browser.cause.incompatible_capabilities.action"
  },
  "update_murage": {
    "messageKey": "browser.cause.update_murage.message",
    "actionKey": "browser.cause.update_murage.action"
  },
  "binding_capacity": {
    "messageKey": "browser.cause.binding_capacity.message",
    "actionKey": "browser.cause.binding_capacity.action"
  },
  "chrome_closed": {
    "messageKey": "browser.cause.chrome_closed.message",
    "actionKey": "browser.cause.chrome_closed.action"
  },
  "debugging_off": {
    "messageKey": "browser.cause.debugging_off.message",
    "actionKey": "browser.cause.debugging_off.action"
  },
  "allow_not_given": {
    "messageKey": "browser.cause.allow_not_given.message",
    "actionKey": "browser.cause.allow_not_given.action"
  },
  "direct_reserved": {
    "messageKey": "browser.cause.direct_reserved.message",
    "actionKey": "browser.cause.direct_reserved.action"
  },
  "stopped": {
    "messageKey": "browser.cause.stopped.message",
    "actionKey": "browser.cause.stopped.action"
  },
  "handoff": {
    "messageKey": "browser.cause.handoff.message",
    "actionKey": "browser.cause.handoff.action"
  },
  "uncertain": {
    "messageKey": "browser.cause.uncertain.message",
    "actionKey": "browser.cause.uncertain.action"
  },
  "connection_lost": {
    "messageKey": "browser.cause.connection_lost.message",
    "actionKey": "browser.cause.connection_lost.action"
  },
  "paused": {
    "messageKey": "browser.cause.paused.message",
    "actionKey": "browser.cause.paused.action"
  },
  "builtin_restart": {
    "messageKey": "browser.cause.builtin_restart.message",
    "actionKey": "browser.cause.builtin_restart.action"
  },
  "browser_sandbox_enable": {
    "messageKey": "browser.cause.browser_sandbox_enable.message",
    "actionKey": "browser.cause.browser_sandbox_enable.action"
  },
  "builtin_page_locked": {
    "messageKey": "browser.cause.builtin_page_locked.message",
    "actionKey": "browser.cause.builtin_page_locked.action"
  },
  "builtin_missing": {
    "messageKey": "browser.cause.builtin_missing.message",
    "actionKey": "browser.cause.builtin_missing.action"
  },
  "builtin_check_failed": {
    "messageKey": "browser.cause.builtin_check_failed.message",
    "actionKey": "browser.cause.builtin_check_failed.action"
  },
  "chrome_status_unknown": {
    "messageKey": "browser.cause.chrome_status_unknown.message",
    "actionKey": "browser.cause.chrome_status_unknown.action"
  }
} as const;
const availability=new Set(['browser_extension_setup_required','host_offline','incompatible_capabilities','update_murage','binding_capacity','chrome_closed','debugging_off','allow_not_given','direct_reserved']);
export function canOfferOwnBrowser(code:string,browserCalls:number){return browserCalls===0&&availability.has(code);}
export function browserFailure(code:string){
 const copy=failures[code as keyof typeof failures]??failures.builtin_check_failed;
 return {code,...copy,message:browserCopy(copy.messageKey),action:browserCopy(copy.actionKey)};
}

/** Only admission failures use zero calls. Failure rows during tool execution
 * must pass their actual call count, so an uncertain outcome cannot offer a move. */
export function codedBrowserReason(code:string,details:string,browserCalls:number){return `browser-cause:${code}:${browserCalls}|${details}`;}
export function readBrowserFailure(reason:string){
 const match=/^browser-cause:([a-z_]+):(\d+)\|([\s\S]*)$/.exec(reason);
 return match?{...browserFailure(match[1]),details:match[3],offer:canOfferOwnBrowser(match[1],Number(match[2]))}:undefined;
}

export function browserReleaseFailureReason(release:{attempts?:number;reason?:string}|undefined){
 return release&&(release.attempts??0)>=3?codedBrowserReason('browser_release_failed',release.reason??browserCopy("browser.server.browser-mode-transition.10"),0):undefined;
}
