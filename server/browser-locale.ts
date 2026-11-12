import de from '../src/locales/de.json' with { type: 'json' };
import es from '../src/locales/es.json' with { type: 'json' };
import fr from '../src/locales/fr.json' with { type: 'json' };
import hi from '../src/locales/hi.json' with { type: 'json' };
import ja from '../src/locales/ja.json' with { type: 'json' };
import pt from '../src/locales/pt-br.json' with { type: 'json' };
import zh from '../src/locales/zh.json' with { type: 'json' };
import { configureBrowserCopy } from '../shared/browser-copy.ts';
export function configureBrowserLocale(language:()=>string|undefined){
 const packs:Record<string,Record<string,string>>={de,es,fr,hi,ja,pt,'pt-br':pt,zh};
 configureBrowserCopy(()=>{const code=(language()??'en').toLowerCase().replaceAll('_','-');return packs[code]??packs[code.split('-')[0]]??{};});
}
