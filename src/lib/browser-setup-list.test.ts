import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect,it } from 'vitest';
import { BrowserSetupListView } from '../components/BrowserSetupList';
it('EP16 setup list is an ordinary card with Dismiss and a picker reopen control',()=>{
 const props={bots:[{id:'a',name:'Ava'},{id:'b',name:'Kai'}],open:true,onDismiss:()=>{},onOpen:()=>{},onSetup:()=>{},onMove:()=>{}};
 const visible=renderToStaticMarkup(createElement(BrowserSetupListView,props));expect(visible).toContain('Dismiss');expect(visible).toContain('Move these to their own browsers');expect(visible).not.toContain('role="dialog"');
 const dismissed=renderToStaticMarkup(createElement(BrowserSetupListView,{...props,open:false}));expect(dismissed).toContain('Show list');expect(dismissed).not.toContain('Move these to their own browsers');
});
