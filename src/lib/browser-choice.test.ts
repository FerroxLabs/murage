import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { BrowserChoiceView } from '../components/BrowserChoice';
for (const mode of ['builtin','chrome-extension','chrome-direct'] as const) it(`EP1 picker stays visible for ${mode}`,()=>{
 const html=renderToStaticMarkup(createElement(BrowserChoiceView,{name:'Ava',mode,choose:()=>{},children:createElement('p',null,'Details')}));
 expect(html).toContain("Ava&#x27;s browser");expect(html).toContain('Your Chrome');expect(html.indexOf('Your Chrome')).toBeLessThan(html.indexOf('Details'));
});
