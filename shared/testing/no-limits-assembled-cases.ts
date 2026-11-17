// SPDX-License-Identifier: AGPL-3.0-or-later
// Classifier inputs only. Never execute these shell strings.
export const assembledWipeCases:{id:string;command:string;wipe:boolean}[]=[
 {id:'review-escaped-consumer',command:String.raw`printf '%s%s -%s ~' r m rf | bas\h`,wipe:true},
 {id:'printf-sh',command:'printf rm | sh',wipe:true},
 {id:'encoded-shell',command:'echo cm0gLXJmIH4= | base64 -d | sh',wipe:true},
 {id:'quoted-command',command:'"b"ash -c x',wipe:true},
 {id:'variable-command',command:'$SHELL -c x',wipe:true},
 {id:'printf-sort',command:String.raw`printf 'a\n' | sort`,wipe:false},
 {id:'echo-grep',command:'echo hi | grep h',wipe:false},
 {id:'printf-done',command:String.raw`printf '%s\n' done`,wipe:false},
];
for(const command of [String.raw`b\ash -c x`,"'bash' -c x",'${SHELL} -c x','ba{sh,sh} -c x']){
 for(const prefix of ['', 'true | ', 'true; ', 'true && ', 'true || ', '(', 'echo $(', 'echo `', 'xargs ', 'env X=ok ', 'command ', 'builtin ', 'env -u X command -- ', 'xargs -I {} ', '2>/tmp/literal-output ', '! ', 'if ', 'true; then ', 'true; do ']){
  const suffix=prefix==='('?')':prefix==='echo $('?')':prefix==='echo `'?'`':'';
  assembledWipeCases.push({id:'O1-'+assembledWipeCases.length,command:prefix+command+suffix,wipe:true});
 }
}
// MAIN RULING T5: O2 requires an executor; output-only consumers run.
for(const producer of ['printf %s harmless','echo harmless']){
 for(const consumer of ['custom-reader','/opt/unknown','sh','env custom-reader','command custom-reader','xargs custom-reader','tee','xargs','/opt/cat','CAT','/opt/env cat','tee "$FILE"','tee >(sh)','(sh)']){
  assembledWipeCases.push({id:'O2-pipe-'+assembledWipeCases.length,command:producer+' | cat | '+consumer,wipe:!['custom-reader','/opt/unknown','command custom-reader','tee','/opt/cat','CAT','tee "$FILE"'].includes(consumer)});
 }
 for(const consumer of ['custom-reader','sh','env custom-reader']){
  for(const substitution of ['$('+producer+')','`'+producer+'`'])assembledWipeCases.push({id:'O2-sub-'+assembledWipeCases.length,command:consumer+' "'+substitution+'"',wipe:consumer==='sh'||consumer==='env custom-reader'});
 }
 for(const consumer of ['cat','head','tail','wc','grep h','sort','uniq','cut -c 1','tr a b','tee /tmp/literal-output','tee -a /tmp/literal-output','/usr/bin/sort']){
  assembledWipeCases.push({id:'reader-'+assembledWipeCases.length,command:producer+' | '+consumer,wipe:false});
 }
}
for(const command of ['cat "$(printf %s harmless)"','cat "`echo harmless`"','env -u "NAME" echo hi','echo "b\\ash"','echo hi; custom-reader','printf hi; custom-reader','echo "$(date)"'])assembledWipeCases.push({id:'inert-'+assembledWipeCases.length,command,wipe:false});

// MAIN RULING K3: disguised env command names remain cards.
for(const command of [String.raw`env --split-string=bas\h`,String.raw`env -Sbas\h`])assembledWipeCases.push({id:'nested-'+assembledWipeCases.length,command,wipe:true});

// MAIN RULING T5: an ordinary consumer does not execute assembled output.
for(const command of ['printf hi | (custom-reader)','(printf hi) | custom-reader','printf hi |\n\ncustom-reader'])assembledWipeCases.push({id:'output-only-'+assembledWipeCases.length,command,wipe:false});
