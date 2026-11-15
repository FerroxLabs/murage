// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { existsSync } from 'node:fs';
it('H2 has one shared policy-owned protected suffix projection',async()=>{
 const path=new URL('./no-limits-cwd-suffix.ts',import.meta.url);
 expect(existsSync(path)).toBe(true);
 const {protectedCwdSuffix}=await import('./no-limits-cwd-suffix.ts');
 for(const name of ['hosts','id_rsa','id_ed25519.pub','authorized_keys','.agents','application_default_credentials.json','.SSH/config','.ZSHRC','.ssh/config','x/.ssh/config','.zshrc','.git/hooks/pre-commit','.aws/credentials','.fuigo/config.toml'])expect(protectedCwdSuffix(name),name).toMatchObject({source:'unknown-cwd-protected-suffix',resolution:'unknown'});
 for(const name of ['notes','file..txt','myhosts','hosts.bak','config','ordinary/config','.ssh-ish/config','notes.pem','.agents/skills/task.md'])expect(protectedCwdSuffix(name),name).toBeUndefined();
 expect(protectedCwdSuffix('hosts')).not.toHaveProperty('physical');
 expect(protectedCwdSuffix('hosts')).not.toHaveProperty('path');
});
