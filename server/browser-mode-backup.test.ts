import {expect,it} from 'vitest';
import {classifyDataDirEntry} from './data-dir-inventory.ts';
it('durable browser selections and their migration marker are backed up as owner records',()=>{
 expect(classifyDataDirEntry('browser-modes.json')).toMatchObject({backup:'record'});
});
