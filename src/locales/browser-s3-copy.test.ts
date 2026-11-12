import {expect,it,afterEach} from 'vitest';
import en from './en.json';
import hashes from './source-hashes.json';
import {createHash} from 'node:crypto';
import {setLocale,t} from '../lib/i18n';
import {renderBrowserCopy} from '../../shared/browser-copy';
import {ownerMoveDisclosure,resolveBrowserDestination} from '../../server/browser-mode-policy';
const packs=import.meta.glob('./{de,es,fr,hi,ja,pt-br,zh}.json',{eager:true,import:'default'}) as Record<string,Record<string,string>>;
afterEach(async()=>{await setLocale('en');});
it('ships the three exact S134 keys and source hashes in every translation draft',()=>{
 const keys=['browser.handback','browser.yourchrome.ask','browser.switchback'] as const;
 expect(en['browser.handback']).toBe('Hand back');
 expect(en['browser.yourchrome.ask']).toBe('{name} needs your logins for this. Use your Chrome from now on?');
 expect(en['browser.switchback']).toBe('Switched from {previous}. Switch back');
 for(const [path,pack] of Object.entries(packs))for(const key of keys){
  expect(pack[key]).toBeTruthy();expect(pack[key]).not.toContain('—');
  const locale=path.slice(2,-5) as keyof typeof hashes.locales;
  expect(hashes.locales[locale][key]).toBe(createHash('sha256').update(en[key]).digest('hex'));
 }
});
it('localizes the complete destination disclosure, including nested browser and account descriptions',async()=>{
 await setLocale('de');const destination=resolveBrowserDestination({id:'a',name:'Ava'},{mode:'builtin'});
 const disclosure=ownerMoveDisclosure({mode:'chrome-extension',revision:0},destination);
 const text=disclosure.copy.map(item=>renderBrowserCopy(item,t)).join(' ');
 expect(text).toContain('Ava');expect(text).not.toContain('its own browser');expect(text).not.toContain('Sites may still be signed in');
 expect(text).not.toContain('Ava\'s own');
});
