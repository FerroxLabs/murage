import en from '../src/locales/en.json' with { type: 'json' };
export type BrowserCopy = { key: keyof typeof en; values?: Record<string,string|number>; parts?: Record<string,BrowserCopy> };
let catalog:()=>Record<string,string> = () => ({});
export function configureBrowserCopy(read:()=>Record<string,string>){catalog=read;}
/** Server fallback and exports use the same source catalog as the renderer. */
export function browserCopy(key: keyof typeof en, values: Record<string,string|number> = {}): string {
  return (catalog()[key]??en[key]).replace(/\{(\w+)\}/g, (token, name: string) => String(values[name] ?? token));
}

export function renderBrowserCopy(copy:BrowserCopy,translate:(key:BrowserCopy['key'],values?:Record<string,string|number>)=>string=browserCopy):string{
 const values={...copy.values};
 for(const [name,part] of Object.entries(copy.parts??{}))values[name]=renderBrowserCopy(part,translate);
 return translate(copy.key,values);
}
