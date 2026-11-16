// This test is copied without product overlays into the complete starting tree.
import {expect,it} from 'vitest';
import {database} from '../database.ts';
import {Store} from '../store.ts';
import * as shell from '../no-limits-shell.ts';
it('S0 RED the real starting schema lacks approval records and guards',()=>{
 new Store();const objects=database().prepare("SELECT name FROM sqlite_schema WHERE name IN ('approval_records','approval_card_insert','approval_card_update')").all();
 expect(objects).toHaveLength(3);
});
it('S0 RED the real starting shell reader must preserve protected heredoc redirects',()=>{
 expect(typeof shell.shellExecutables).toBe('function');
 expect(shell.shellExecutables("cat <<'EOF' > /etc/cron.d/x\nfixture\nEOF",0,[])).toContain('/etc/cron.d/x');
});
