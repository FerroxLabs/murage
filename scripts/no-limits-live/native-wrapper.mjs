// Harness loader owner: afix-gnl-harness-r10. Native protocol producer: MAIN.
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
import {generatedNativeSource} from './native-source.mjs';
export const nativeFiles={
 pi:new URL('../../server/testing/fake-pi-cli.ts',import.meta.url),
 muse:new URL('../../server/testing/fake-muse-cli.ts',import.meta.url),
 agy:new URL('../../server/testing/fake-agy-cli.ts',import.meta.url),
};
const kind=process.argv[1].includes('fake-pi-')?'pi':process.argv[1].includes('fake-muse-')?'muse':'agy';
registerHooks({load(url,context,next){
 const loaded=next(url,context);
 if(!url.startsWith(new URL('../../server/testing/',import.meta.url).href)||!url.endsWith('.ts'))return loaded;
 const source=generatedNativeSource(url,readFileSync(new URL(url),'utf8'));
 return {format:'module',source:stripTypeScriptTypes(source),shortCircuit:true};
}});
await import(nativeFiles[kind].href);
