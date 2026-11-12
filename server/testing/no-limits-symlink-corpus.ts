// SPDX-License-Identifier: AGPL-3.0-or-later
// r3.1 executable inspection corpus. Commands are inspected, NEVER executed.
export interface SymlinkCase {
  id: string; command: string; twin: string; setup?: string; selected?: string;
  tool?: string; cause?: string;
}
export const symlinkCorpus: SymlinkCase[] = [
  { id:'A01', setup:'h', command:'mv -n blob h && tee h', twin:'mv -n blob h && tee h', selected:'h' },
  { id:'A01-negated', setup:'h', command:'! mv -n blob h; tee h', twin:'! mv -n blob h; tee h', selected:'h' },
  { id:'A02', setup:'h', command:'ln -sf --backup=simple /tmp/blob h && tee h~', twin:'ln -sf --backup=simple /tmp/blob h && tee h~', selected:'h~' },
  { id:'A03', setup:'tree', command:'mv a b && mv b c && tee c/h', twin:'mv a b && mv other c && tee c/h', selected:'c/h' },
  { id:'A04', setup:'copy', command:'cp -RP src dst', twin:'cp -RP src dst', selected:'dst' },
  { id:'A05', command:'if c; then d=./safe; t=/etc/hosts; else d=./h; t=/tmp/blob; fi; ln -s "$t" "$d"; tee ./h', twin:'if c; then ln -s ./plain ./safe; else ln -s ./blob ./h; fi; tee ./h', selected:'h' },
  { id:'A06', command:'if c; then p=\'ln -s /etc/hosts ./h\'; else p=\'ln -s ./plain ./h\'; fi; eval "$p"; tee ./h', twin:'eval \'ln -s ./plain ./h\'; tee ./h', selected:'h' },
  { id:'A07', command:'ln -sf /etc/hosts ./h < <(tee ./h)', twin:'ln -sf ./plain ./h < <(tee ./h)', selected:'h' },
  ...['-b','-S.bak','-S .bak','--suffix=.bak','--backup=numbered','--backup=existing'].map((option,i)=>({id:`B01-${i}`,setup:'h',command:`ln -sf ${option} /tmp/blob h; tee h.bak`,twin:`ln -sf ${option} /tmp/blob h; tee h.bak`,selected:'h.bak'})),
  { id:'B01-dir', setup:'backup', command:'rsync -a --backup --backup-dir=./backup/deep ./source/ ./work/deep/; tee ./backup/deep/h', twin:'rsync -a --backup --backup-dir=./backup/deep ./source/ ./work/deep/; tee ./backup/deep/h', selected:'backup/deep/h' },
  { id:'B02', setup:'copy', command:'cp -RL src dst; tee dst/src/f', twin:'cp -RL src dst; tee dst/src/f', selected:'dst/src/f' },
  ...['f() { BODY; }; f','while c; do BODY; done','echo $(BODY)','BODY | cat',"sh -c 'BODY'",'sh <<\'EOF\'\nBODY\nEOF'].map((shape,i)=>({id:`B03-${i}`,command:shape.replace('BODY','ln -s /etc/hosts ./h; tee ./h'),twin:shape.replace('BODY','ln -s ./plain ./h; tee ./h'),selected:'h'})),
  { id:'B04', command:'ln -s "$t" ./h; tee ./h', twin:'ln -s ./plain ./h; tee ./h', selected:'h' },
  { id:'B04-destination', command:'ln -s ./plain "$(printf h)"; tee ./other', twin:'ln -s ./plain ./h; tee ./other', selected:'other' },
  { id:'B09', setup:'h', command:'printf x > h', twin:'printf x > h', selected:'h' },
  { id:'B09-dangling', setup:'dangling', command:'tee h', twin:'tee h', selected:'h' },
  { id:'B11', command:'ln -s ./data/../data ./cur; tee ./cur/notes', twin:'ln -s ./data ./cur; tee ./cur/notes', selected:'cur/notes', cause:'dotdot-value' },
  { id:'B12', command:'ln -s /etc/hosts ./one/h; mv ./one/h ./two/h; tee ./two/h', twin:'mv ./one/h ./two/h; tee ./two/h', selected:'two/h' },
  { id:'B13', command:'ln -s /etc/hosts ./one/h; mv ./two/src ./two/out; tee ./two/out', twin:'ln -s ./plain ./one/h; mv ./two/src ./two/out; tee ./two/out', selected:'two/out' },
  { id:'B14', setup:'tree', command:'mv ./a ./b; tee ./b/h', twin:'mv ./a ./b; tee ./b/h', selected:'b/h' },
  { id:'D31a', command:'ln -s /tmp ./a; ln -s a/../etc ./b; tee ./b/hosts', twin:'ln -s ./data ./cur; tee ./cur/notes', selected:'b/hosts', cause:'dotdot-value,producer-dependency' },
  { id:'D31b', command:'ln -s ./data ./a; ln -s ./a ./b; tee ./b/notes', twin:'ln -s ./data ./a; ln -s ./data ./b; tee ./b/notes', selected:'b/notes', cause:'producer-dependency' },
  { id:'D31c-reversed', command:'ln -s ./a ./b; ln -s ./data ./a; tee ./b/notes', twin:'ln -s ./data ./b; ln -s ./data ./a; tee ./b/notes', selected:'b/notes', cause:'producer-dependency' },
  { id:'D31c-dotdot', command:'ln -s ./data/../data ./cur; tee ./cur/notes', twin:'ln -s ./data ./cur; tee ./cur/notes', selected:'cur/notes', cause:'dotdot-value' },
  ...['cp blob d','mv blob d','install blob d','ln blob d','ln -sf ./blob d','rsync blob d/'].map((command,i)=>({id:`E32${i===0?'a':`b-${i}`}`,setup:'child',command,twin:command,selected:'d/blob'})),
  ...['cp','mv','install','ln'].flatMap(name=>['-t d','-td','--target-directory=d'].map((opt,i)=>({id:`E32c-${name}-${i}`,setup:'children',command:`${name} ${opt} blob plain`,twin:`${name} ${opt} blob plain`,selected:'d/plain'}))),
  { id:'E32d', setup:'child', command:'cp blob d/', twin:'cp blob d/', selected:'d/blob' },
  { id:'E32e', command:'cp -T blob /etc/murage-fixture', twin:'cp -T blob d', selected:'/etc/murage-fixture' },
  { id:'E32f-slash', setup:'rsync', command:'rsync -r src/ d/', twin:'rsync -r src/ d/', selected:'d/blob' },
  { id:'E32f-name', setup:'rsync', command:'rsync -r src d/', twin:'rsync -r src d/', selected:'d/src/blob' },
  { id:'E32f-inplace', setup:'rsync', command:'rsync -r --inplace src/ d/', twin:'rsync -r --inplace src/ d/', selected:'d/blob' },
  { id:'C33a', setup:'cwd', command:'cd -P e; cd ..; printf x > hosts', twin:'cd -L e && cd .. && printf x > hosts', selected:'hosts' },
  ...['-Pe --','-L -P','-P'].map((opts,i)=>({id:`C33b-${i}`,setup:'cwd',command:`cd ${opts} e && cd .. && printf x > hosts`,twin:'cd -P -L e && cd .. && printf x > hosts',selected:'hosts'})),
  { id:'C33c', setup:'cwd', command:'d=./e; cd -P "$d"; cd ..; printf x > hosts', twin:'d=./e; cd -P "$d"; cd ..; printf x > hosts', selected:'hosts' },
  { id:'C33d', command:'cd /etc && pushd $FX/sub && popd && printf x > hosts', twin:'cd sub && pushd $FX/data && popd && printf x > notes', selected:'hosts' },
  { id:'C33e', setup:'h', command:'cd missing; printf x > h', twin:'cd missing; printf x > h', selected:'h' },
  ...['hosts','.zshrc','.ssh/config'].map((suffix,i)=>({id:`C33f-${i}`,command:`cd "$(opaque-dir)"; printf x > ${suffix}`,twin:'cd "$(opaque-dir)"; printf x > notes',selected:suffix,cause:'unknown-cwd-protected-suffix'})),
  { id:'S08a', command:'ln -L /etc/hosts ./x', twin:'ln -L ./plain ./x', selected:'x', cause:'hard-link-source' },
  { id:'S08c', setup:'chain', command:'tee h0', twin:'tee plain', selected:'h0', cause:'exhaustion' },
  { id:'S08d', command:'printf x > /usr/local/murage-fixture', twin:'printf x > ./ordinary', selected:'/usr/local/murage-fixture' },
  { id:'AR11a', command:'tar -tf ./a.tar --index-file=/etc/list', twin:'tar -tf ./a.tar --index-file=./list' },
  { id:'AR11b', command:'tar -cf ./a.tar -f /etc/b.tar ./plain', twin:'tar -cf ./a.tar -f ./b.tar ./plain' },
  { id:'AR11c', command:'tar -cf ./a.tar --listed-incremental=/etc/snapshot ./plain', twin:'tar -cf ./a.tar --listed-incremental=./snapshot ./plain' },
  { id:'AR11d', command:'tar -cf ./a.tar --remove-files /etc/hosts', twin:'tar -cf ./a.tar --remove-files ./plain' },
  { id:'AR11e', command:'tar -xPf ./a.tar -C ./out /etc/hosts', twin:'tar -xPf ./a.tar -C ./out ./plain' },
  { id:'AR11f', command:'cd /etc; tar -tf ./a.tar --index-file=-', twin:'tar -tf ./a.tar --index-file=-' },
  { id:'AR11g', command:'unzip ./a.zip -d /etc', twin:'unzip ./a.zip -d ./out' },
  ...['/J','/D','/H',''].map((opt,i)=>({id:`W12-${i}`,tool:'cmd',command:`mklink ${opt} .\\h C:\\Windows\\named & echo x > .\\h\\x`,twin:`mklink ${opt} .\\h C:\\work\\plain & echo x > .\\h\\x`,selected:'h/x'})),
  ...['Junction','SymbolicLink','HardLink'].map((type,i)=>({id:`W12-${i+4}`,tool:'pwsh',command:`New-Item -ItemType ${type} -Path .\\h -Target C:\\Windows\\named; Set-Content .\\h x`,twin:`New-Item -ItemType ${type} -Path .\\h -Target C:\\work\\plain; Set-Content .\\h x`,selected:'h'})),
  { id:'W12h', tool:'pwsh', command:'Move-Item -Path C:\\Windows\\named -Destination .\\out; Set-Content .\\out x', twin:'Move-Item -Path C:\\work\\plain -Destination .\\out; Set-Content .\\out x', selected:'out' },
];

export const ordinaryBoundaries = [
  ['B05','ln -s ./plain ./one/h; tee ./two/notes'],
  ['B06','ln -s ./plain ./h; tee "$(cat f)"'],
  ['B06-unknown','tee "$(cat f)"'],
  ['B06-cwd','cd "$(opaque-dir)"; tee notes'],
  ['B08','tar -xf ./a.tar -C ./out; tee ./out/h'],
  ['B08-cpio','cpio -i < ./a.cpio; tee ./h'],
  ['B08-opaque','producer; tee ./h'],
  ['B10-stream','printf x > /dev/stdout'],
  ['C33f-file','cd "$(opaque-dir)"; tee file..txt'],
  ['C33f-mismatch','cd "$(opaque-dir)"; tee hosts-copy'],
  ['E32e-no-child','cp -T blob d'],
  ['U31-dot-name','ln -s ./file..txt ./cur; tee ./cur/notes'],
] as const;

// Runtime timing barriers and exact operation assertions belong to C6/C7a.
// These are contract rows, not evidence that a real route has been verified.
export const releaseCorpus = [
  'R10a','R10b-write','R10b-edit','R10b-delete','R10c1','R10c2',
  'R10c3-native','R10c3-legacy','R10c4','R10d-native','R10d-shell',
  'R10e','R10f','R10g','R10h','E32g','C33h','H12a','H12b','H12c','H12d','S08b',
] as const;
