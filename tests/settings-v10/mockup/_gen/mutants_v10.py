# Each mutant changes the generator and must fail the corresponding fixture check.
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

GEN = Path(__file__).resolve().parent
MUTS = [
 ('MUT1', 'the restored-routine Fix points to the ordinary routines page', 'pages_extra.py',
  'bot-routines-restored.html#bot.routines.morning', 'bot-routines.html#bot.routines.morning'),
 ('MUT2', 'the phone draws the desktop bot Tools body', 'pages_extra.py',
  'PB.bot_tools_body(phone=True)', 'PB.bot_tools_body()'),
 ('MUT3', 'Weekly report opens the Invoice chase sheet', 'pages_skills.py',
  'SHEETS[n] = sheet_href(n); return SHEETS[n]', 'SHEETS[n] = sheet_href(n); return "skills-sheet.html" if n == "Weekly report" else SHEETS[n]'),
 ('MUT4', 'the restored routine is drawn On', 'pages_bot.py',
  "id='bot.routines.morning', on=False", "id='bot.routines.morning', on=True"),
 ('MUT5', 'H5: the restored-routine arrival is drawn after the rail switches to Old Dax', 'pages_bot.py',
  "    core.BOTCTX.update(n='Old Dax', role='Archived. Inbox assistant', av='O', needs={})\n", None),
 ('MUT6', 'C1a: dialog 1 back to "Sable, Kit, Rhea and 9 more"', 'pages_app.py',
  '<b>{", ".join(F.EVERY_APP[:-1])} and {F.EVERY_APP[-1]}</b>', '<b>{F.every_line()}</b>'),
 ('MUT7', 'H3a: the Move all list leaves out one bot at Auto', 'pages_app.py',
  '{", ".join(ns)}.\' for lv in', '{", ".join(ns[:-1] if lv == "Auto" else ns)}.\' for lv in'),
 ('MUT8', 'C1b: a bot with Connected apps off is listed as getting the app in dialog 3', 'pages_app.py',
  '<li><b>Pepper</b>, at No limits.</li><li>The chat <b>{F.NL_CHATS[0][1]}</b> with {F.NL_CHATS[0][0]}, set to No limits. {',
  '<li><b>Pepper</b>, at No limits.</li><li><b>{F.APPS_OFF[0]}</b>, set to Every app.</li><li>The chat <b>{F.NL_CHATS[0][1]}</b> with {F.NL_CHATS[0][0]}, set to No limits. {'),
 ('MUT9', 'H4a: the bulk Archive review does not name the apps Atlas loses', 'pages_app.py',
  "        a = [x for x, v in F.APPS.items() if n in v['saved']]\n", "        a = [x for x, v in F.APPS.items() if n in v['saved'] and n != 'Atlas']\n"),
 ('MUT10', 'H3a: the Move all list leaves out the chat Payroll questions', 'pages_app.py',
  "    cs = F.MOVE_CHATS; mine", "    cs = F.MOVE_CHATS[:1] + F.MOVE_CHATS[2:]; mine"),
 ('MUT11', 'H3a: the Move all routines are named without the level each one loses', 'pages_app.py',
  "({b}), at {lv}.{", "({b}).{"),
 ('MUT12', 'Fable v9 H1: the team dialog says keeping the bots is lossless again', 'pages_bot.py',
  "Both choices clear these saved app choices:", "To keep the bots as they are, delete only the team."),
 ('MUT13', 'Astra r9 H4b: the team review drops a member (Juno) from the list', 'pages_bot.py',
  "    lost = [(b, [a for a, v in F.APPS.items() if b in v['saved']]) for b in mem]\n", "    lost = [(b, [a for a, v in F.APPS.items() if b in v['saved']]) for b in mem if b != 'Juno']\n"),
 ('MUT14', 'Fable v9 H1: the keep button says "Delete the team only" again', 'pages_bot.py',
  "A('Delete team and keep bots', 'bot.teams.deletekeep', 'red', note, 'new', slabel='Delete a team and keep its bots')",
  "A('Delete the team only', 'bot.teams.deletekeep', 'red', note, 'new', slabel='Delete a team and keep its bots')"),
]
expected = [
    'restored routine does not link', 'draws a switch', 'Weekly report', 'off since the restore',
    'Old Dax', 'and N more', 'Move all lists', 'listed as getting the app', 'Atlas loses',
    'Payroll questions', 'Move all names 0 routines', 'false promise in team-delete review',
    'team-delete review lists', '"Delete team and keep bots" is not drawn',
]
only = sys.argv[1] if len(sys.argv) > 1 else None
for (mid, description, filename, old, new), witness in zip(MUTS, expected, strict=True):
    if only and mid != only: continue
    with TemporaryDirectory(prefix='settings-v10-mut-') as tmp:
        scratch = Path(tmp) / '_gen'
        shutil.copytree(GEN, scratch)
        path = scratch / filename
        source = path.read_text()
        assert old in source, (mid, 'anchor missing')
        if mid == 'MUT5':
            start = source.index("    P('bot-routines-restored.html'")
            end = source.index(old, start)
            source = source[:start] + old + source[start:end] + source[end + len(old):]
        else:
            source = source.replace(old, new, 1)
        path.write_text(source)
        run = subprocess.run([sys.executable, '-BI', str(scratch / 'build.py')], capture_output=True, text=True, check=True)
        result = re.search(r'^fixture consistency: .*, ([1-9]\d*) mismatches\n((?: +[^\n]+\n)+)', run.stdout, re.M)
        assert result, (mid, 'mutant survived')
        failures = result[2].splitlines()
        assert any(witness.lower() in line.lower() for line in failures), (mid, witness, failures[:4])
        print(f'{mid} {description} -> RED ({result[1]})')
        for line in failures[:3]:
            print(line)
