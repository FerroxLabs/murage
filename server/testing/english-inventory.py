#!/usr/bin/env python3
"""Read-only inventory of added English literals across the complete lane range."""
from pathlib import Path
import argparse, difflib, json, re, subprocess
parser = argparse.ArgumentParser()
parser.add_argument('tip', nargs='?', default='HEAD')
parser.add_argument('--base', default='b4dc27ea9')
parser.add_argument('--output', default='evidence/r4/english-inventory.json')
args = parser.parse_args()
def git(*argv): return subprocess.check_output(['git', *argv], text=True, stderr=subprocess.PIPE)
diff = git('diff', '--no-ext-diff', '-U0', args.base, args.tip, '--', '.', ':!*.test.ts', ':!server/testing/**', ':!server/memory/testing/**')
changes, removed, file, new_line, old_line = {}, {}, None, 0, 0
for line in diff.splitlines():
 if line.startswith('+++ b/'): file = line[6:]; changes.setdefault(file, set()); removed.setdefault(file, [])
 elif line.startswith('@@'):
  new_line = int(re.search(r'\+(\d+)', line).group(1)); old_line = int(re.search(r'-(\d+)', line).group(1))
 elif line.startswith('+') and not line.startswith('+++'): changes[file].add(new_line); new_line += 1
 elif line.startswith('-') and not line.startswith('---'): removed[file].append((old_line,line[1:])); old_line += 1
 elif line.startswith(' '): new_line += 1; old_line += 1
sql = re.compile(r'^\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|EXPLAIN|WITH|WHERE|FROM|JOIN|AND|OR|ORDER|LIMIT|SET|VALUES|VACUUM|ANALYZE|REINDEX|EXCEPT|UNION|AS)\b', re.I)
# Lex quoted strings and comments. Recurse into String.raw worker bodies rather
# than treating the complete embedded program as one English literal.
lex = re.compile(r'//[^\n]*|/\*[\s\S]*?\*/|(?P<q>[\'"`])(?P<body>(?:\\[\s\S]|(?!\1)[\s\S])*?)(?P=q)')
def literals(source, offset=0):
 for m in lex.finditer(source):
  if not m.group('q'): continue
  body = m.group('body')
  if m.group('q') == '`' and source[max(0,m.start()-10):m.start()].endswith('String.raw'):
   yield from literals(body, offset+m.start('body'))
  else: yield offset+m.start(), body
def function_key(source, position):
 matches = list(re.finditer(r'\bfunction\s+([\w$]+)\s*\(', source[:position]))
 return matches[-1].group(1) if matches else '<module>'
inventory=[]
for file, added in changes.items():
 if not added: continue
 try: source = git('show', args.tip+':'+file)
 except subprocess.CalledProcessError: continue
 try: original_source = git('show', args.base+':'+file)
 except subprocess.CalledProcessError: original_source = ''
 original_lines = original_source.splitlines(True)
 new_lines = source.splitlines(True)
 # Pair edited call-site lines one-to-one, using the owning function and Git's
 # changed lines. A new adjacent UI call cannot borrow the old call's status.
 candidates=[]
 for new_number in added:
  current_line=new_lines[new_number-1].strip()
  if not re.search(r"['\"`]",current_line): continue
  current_key=function_key(source,sum(map(len,new_lines[:new_number-1])))
  for old_number,old_text in removed[file]:
   if current_key != function_key(original_source,sum(map(len,original_lines[:old_number-1]))): continue
   score=difflib.SequenceMatcher(None,current_line,old_text.strip()).ratio()
   if score>=0.7: candidates.append((score,new_number,old_number))
 paired=set();used_old=set()
 for score,new_number,old_number in sorted(candidates,reverse=True):
  if new_number not in paired and old_number not in used_old: paired.add(new_number);used_old.add(old_number)
 for position, literal in literals(source):
  line = source.count('\n',0,position)+1
  end = line+literal.count('\n')
  if not any(n in added for n in range(line,end+1)): continue
  visible = re.sub(r'\$\{.*?\}', '', literal)
  if not (' ' in visible or re.match(r'^\[[\w-]+\]',visible)): continue
  if sql.match(literal) or '\n' in literal or len(literal)>1000: continue
  if not re.search(r'[A-Za-z]{2}',literal): continue
  context = source[max(0,source.rfind('\n',0,position)-150):source.find('\n',position)]
  if 'fixture' in literal or 'barrier' in context or 'scrub-busy' in literal: kind='test-hook'
  elif re.search(r'console\.(?:warn|error|log)|recoveryWarning|\[(?:message-search|wal|sqlite)\]',context): kind='diagnostic'
  elif re.search(r'(?:throw|new)\s+(?:new\s+)?Error|throw\s+Error',context): kind='internal-error'
  elif file.endswith('conversation-deletion.ts'): kind='UI'
  else: kind='internal-error'
  # Compare the deleted call-site line with the added one, including unchanged
  # strings on edited calls. Added functions without a deleted call are NEW.
  current_line=source.splitlines()[line-1].strip()
  prefix=re.split(r'[\'"`]',current_line,1)[0].strip()
  changed=line in paired
  inventory.append({'file':file,'line':line,'literal':literal,'class':kind,'change':'CHANGED' if changed else 'NEW'})
output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(inventory,indent=2,ensure_ascii=False)+'\n')
print(json.dumps(inventory,indent=2,ensure_ascii=False))
