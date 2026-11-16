import {expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA_DIR} from '../config.ts';
import {fixture,d} from './fixture.ts';
import {readThread} from '../message-db.ts';
it('A5a M56 lazy legacy unanswered permission rows are terminal on import',()=>{
 fixture();const path=join(DATA_DIR,'legacy.json');writeFileSync(path,JSON.stringify([{id:'old',at:1,role:'bot',kind:'options',card:{requestId:'r',title:'Old',subtitle:'x',options:['Allow','Deny']}},{id:'answered',at:2,role:'bot',kind:'options',card:{requestId:'r2',title:'Old',subtitle:'x',options:['Allow'],answered:'Allowed'}}]));
 const rows=readThread('legacy',path).messages;expect(rows[0].card?.orphaned).toBe(true);expect(rows[0].card?.answered).toBe('Expired (upgrade)');expect(rows[1].card?.answered).toBe('Allowed');expect(d.openApprovals()).toHaveLength(0);
});
it('A5a malformed legacy JSON has no actionable presentation',()=>{fixture();const path=join(DATA_DIR,'bad-legacy.json');writeFileSync(path,'{invalid');expect(readThread('invalid',path).messages).toHaveLength(0);});
