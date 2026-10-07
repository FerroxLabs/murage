// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect,it } from "vitest";
import { BrowserSetupCard } from "./BrowserSetupCard";
import type {Bot,Message} from "@/state/store";
const bot={id:"bot",name:"Mira"} as Bot;
const message={id:"message",role:"bot",kind:"options",at:1,card:{title:"Use your browser?",subtitle:"Your signed-in task",options:[],browserSetup:{requestKey:"key",botId:"bot",threadId:"thread",ownerMessageId:"original"}}} as Message;
it("renders optional owner decision without pretending connected",()=>{const html=renderToStaticMarkup(createElement(BrowserSetupCard,{bot,message}));expect(html).toContain("Set up my browser");expect(html).toContain("Not now");expect(html).toContain("This is optional");expect(html).toContain("Browser to connect");expect(html).toContain('value="brave"');expect(html).toContain("Set up also enables browser tools in this workspace.");expect(html).not.toContain("Connection checked");});
it("accepted card waits for explicit connection check",()=>{const next={...message,card:{...message.card!,browserSetup:{...message.card!.browserSetup!,decision:"accepted" as const}}};const html=renderToStaticMarkup(createElement(BrowserSetupCard,{bot,message:next}));expect(html).toContain("Your task has not restarted");expect(html).toContain("Check connection and continue");expect(html).not.toContain("href=");});
it("declined card preserves original conversation",()=>{const next={...message,card:{...message.card!,browserSetup:{...message.card!.browserSetup!,decision:"declined" as const,resumed:true}}};const html=renderToStaticMarkup(createElement(BrowserSetupCard,{bot,message:next}));expect(html).toContain("You chose not to connect");expect(html).not.toContain("Set up my browser");});
import { BrowserSetupCardView } from "./BrowserSetupCard";
const setup=message.card!.browserSetup!;
const view=(extra:Record<string,unknown>)=>renderToStaticMarkup(createElement(BrowserSetupCardView,{bot,subtitle:"Your signed-in task",setup,profiles:[],profile:"",pending:false,browser:"chrome",error:"",storeUrl:null,extensionBuild:"development",onBrowser:()=>{},onProfile:()=>{},onAct:()=>{},...extra} as any));
it("a release build before the listing is public says so and does not offer Set up",()=>{const html=view({extensionBuild:"release"});expect(html).toContain("Murage for Chrome is not in the Chrome Web Store yet");expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Set up my browser<\/button>/);expect(html).toContain("Not now");});
it("an accepted card links the listing when it is public",()=>{const url="https://chromewebstore.google.com/detail/"+"c".repeat(32);const html=view({extensionBuild:"release",storeUrl:url,setup:{...setup,decision:"accepted"}});expect(html).toContain(`href="${url}"`);expect(html).toContain("Open Chrome Web Store");expect(html).not.toContain("unpacked development extension");expect(html).toContain("Check connection and continue");});
it("a development build keeps its truthful development line",()=>{const html=view({setup:{...setup,decision:"accepted"}});expect(html).toContain("unpacked development extension");expect(html).not.toContain("href=");});
it("a remembered connection names its browser and does not ask which browser again",()=>{
 const remembered={...setup,decision:"accepted" as const,profileId:"profile_a",browser:"brave" as const};
 const waiting=view({setup:remembered});
 expect(waiting).toContain("Brave");expect(waiting).not.toContain("Browser to connect");expect(waiting).toContain("Your task has not restarted");
 const ready=view({setup:remembered,profiles:[{profileId:"profile_a",browser:"chromium"},{profileId:"profile_b",browser:"chromium"}]});
 expect(ready).toContain("connected");expect(ready).not.toContain("Choose a profile");
 // Only a different profile is online: the owner chooses, nothing switches silently.
 const other=view({setup:remembered,profiles:[{profileId:"profile_b",browser:"chromium"}]});
 expect(other).toContain("Browser profile");expect(other).toContain("Choose a profile");
});
it("the offer starts on the browser this bot used before",()=>{const html=renderToStaticMarkup(createElement(BrowserSetupCard,{bot:{...bot,browserExtensionBrowser:"edge"} as Bot,message}));expect(html).toMatch(/<option value="edge" selected="">/);});
it("a remembered card keeps Not now next to Continue; a freshly accepted one does not",()=>{
 const remembered=view({setup:{...setup,decision:"accepted" as const,remembered:true as const,profileId:"profile_a",browser:"brave" as const}});
 expect(remembered).toContain("Not now");expect(remembered).toContain("Check connection and continue");
 expect(view({setup:{...setup,decision:"accepted" as const}})).not.toContain("Not now");
});
