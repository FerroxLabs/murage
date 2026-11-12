// Sean ruling 2026-11-12 02:05Z: every former hold runs, only wipes card.
// Commands are inert requests to the fake approval relay; never executed.
const run=(id,command,extra={})=>({id,actor:'owner',level:'unlimited',expected:'RUN',expectedCards:0,tool:'Bash',input:{command},...extra});
const wipe=(id,command,extra={})=>({...run(id,command,extra),expected:'CARD',expectedCards:1,why:'wipe'});
export const trulyRows=[
 run('truly-F1-outside-turn','touch notes.md',{outside:'web-read'}),
 run('truly-F2-unmodeled','eval "$OPAQUE"'),
 run('truly-F2-reader-failed','python3 -c "import ctypes; ctypes.CDLL(None)"'),
 run('truly-F2-tokenizer','echo "unterminated'),
 run('truly-F3-key-row','printf x > ~/.ssh/id_ed25519'),
 run('truly-F3-protected-path','touch /etc/fixture-policy'),
 run('truly-F3-sensitive','cat .env.production'),
 run('truly-F3-home-glob','ls ~/*'),
 run('truly-F4-cut','printf ok …[truncated, 100 characters more]'),
 run('truly-F4-U19','PAGER=less git log'),
 run('truly-F5-refusal','unknown-program /etc'),
 run('truly-F5-own-tool','',{tool:'mcp__murage__publish_site',input:{name:'fixture'}}),
 run('truly-F6-routine-no-grant','eval "$ROUTINE"',{routine:true}),
 wipe('truly-F8-plain-wipe','rm -rf ~'),
 wipe('truly-F8-tainted-wipe','rm -rf ~',{outside:'web-read'}),
 wipe('truly-F8-unreadable-wipe','eval "$OPAQUE"; rm -rf ~'),
 wipe('truly-F8-cut-wipe','rm -rf ~ …[truncated, 100 characters more]'),
 wipe('truly-F8-database-wipe',"psql -c 'DROP TABLE fixture'"),
 wipe('truly-F8-history-wipe','git push --force origin HEAD:main'),
 wipe('truly-F8-backup-wipe','rm -rf ~/backups'),
];

// R3: real incoming runs exercise inheritance, origin, the channel switch and
// the narrowed catastrophe list. All requested commands remain inert relay data.
trulyRows.push(
 run('truly-R3-guest-inherited','eval "$OPAQUE"',{incoming:true,inherit:true,expected:'CARD',expectedCards:1}),
 run('truly-R3-guest-explicit-no-limits','eval "$OPAQUE"',{incoming:true,permissionExplicit:true}),
 run('truly-R3-webhook-inherited','eval "$OPAQUE"',{incoming:true,inherit:true}),
 wipe('truly-R3-webhook-inherited-wipe','rm -rf ~',{incoming:true,inherit:true}),
 run('truly-R3-webhook-explicit','eval "$OPAQUE"',{incoming:true}),
 wipe('truly-R3-webhook-explicit-wipe','rm -rf ~',{incoming:true}),
 run('truly-R3-channel-off','eval "$OPAQUE"',{incoming:true,channelOff:true,feature:'channel-messages',expected:'OFF_WITH_LINE',expectedCards:0}),
 run('truly-R3-channel-on','eval "$OPAQUE"',{incoming:true}),
 run('truly-R3-lead-wins','eval "$OPAQUE"',{inherit:true}),
 run('truly-R3-terms-stale','eval "$OPAQUE"',{staleTerms:true}),
 ...['git reset --hard HEAD~3','git push --force-with-lease origin main','git push --delete origin feature','rm -f .git/index.lock','rm -rf vendor/x/.git','rm old/backup/x.tmp','eval "$OPAQUE"; npm remove fixture','eval "$OPAQUE"; curl -X DELETE https://fixture.invalid'].map((command,i)=>run('truly-R3-ordinary-'+i,command)),
 run('truly-R3-summary-data','',{tool:'mcp__fixture__describe',input:{name:'delete remove rm'},summary:'delete remove rm'}),
 wipe('truly-R3-reflog-gc','git reflog expire --expire=now --all; git gc --prune=now'),
 wipe('truly-R3-whole-project','rm -rf .'),
 wipe('truly-R3-whole-git','rm -rf .git'),
 wipe('truly-R3-filter-repo','git filter-repo --invert-paths --path fixture'),
 run('truly-F7-existing-owner-default','eval "$OPAQUE"',{oldOwnerDefault:true}),
 run('truly-R3-quoted-device-data','echo "mkfs.ext4 /dev/fixture"'),
 run('truly-R3-remote-main-feature','git push --force main feature'),
 wipe('truly-R3-wrapped-history',"bash -c 'git push --force origin main'"),
 run('truly-F7-use-all-inherited-routine','eval "$ROUTINE"',{inherit:true,routine:true,useAll:true}),
);

trulyRows.push(
 wipe('truly-R3-native-python-root','',{tool:'python',input:{code:"import shutil; shutil.rmtree('/')"}}),
 run('truly-R3-native-python-data','',{tool:'python',input:{code:`print("shutil.rmtree('/')")`}}),
 run('truly-R3-shell-argument-data',`bash -c true -c 'rm -rf /'`),
);
