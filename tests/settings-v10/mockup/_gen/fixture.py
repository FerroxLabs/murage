# Settings v7: THE fixture. One source for every value a mockup shows about the owner, the bots and Dax.
# Every page reads from here. build.py checks every page against it and fails loudly on a mismatch.
NAMES = ['Chief', 'Dax', 'Pepper', 'Sable', 'Juno', 'Atlas', 'Mira', 'Otto', 'Nova', 'Kit', 'Rhea', 'Finn', 'Vera', 'Bram', 'Lux', 'Tess',
         'Odin', 'Wren', 'Cato', 'Zia', 'Hugo', 'Ines', 'Jett', 'Koa', 'Lena', 'Milo', 'Nell', 'Oren', 'Pia', 'Quin', 'Remy', 'Suki',
         'Theo', 'Uma', 'Vic', 'Willa', 'Xan', 'Yara', 'Zed']
ROLES = ['Chief of staff', 'Inbox assistant', 'Research', 'Support', 'Bookkeeping', 'Scheduling', 'Sales follow-up', 'Writing']
AUTO_MODEL = 'Auto model'   # v7 (Walk r6 H2): the Fuigo model selection is never written as a bare "Auto", which is an approval level
ENG = [('Fuigo', AUTO_MODEL), ('Claude Code', 'Claude Sonnet'), ('Fuigo', AUTO_MODEL), ('Codex', 'GPT-5'), ('Claude Code', 'Claude Opus'), ('Fuigo', AUTO_MODEL)]
_LV = ['Ask', 'Ask', 'Auto', 'Full access', 'Ask', 'Auto']
NEW_LEVEL = 'Auto'                                  # Bots > New bots start with
# One meaning per level, word for word from the shipped strings (src/locales/en-ux/l1.json:105-108, :184, :138). build.py fails on any other wording.
LEVEL_MEANING = {
 'Ask': 'Asks before each action that needs your yes. Writing in its own folder goes ahead.',
 'Auto': 'Asks before paying, emailing someone new, posting in public, or deleting outside its folder.',
 'Full access': 'Still asks before paying, emailing someone new, posting in public, deleting outside its folder, or reading your keys and passwords.',
 'No limits': 'Runs without asking in chats that are yours alone. Only a likely wipe or catastrophe asks first.',
}
# v7 (Walk r6 H1): the shipped "What each level asks about" table. Rows and cells are shared/level-examples.ts:46-58 (OWNER_ROWS), labels are
# src/locales/en-ux/l1.json:114-125, heading :109, toggle :110, cells :112-113. A = Asks, G = Goes ahead. Q1 compares these cells with the shared file.
LEVEL_TABLE_HEADING = 'What each level does when nothing has been approved yet'
LEVEL_TABLE_TOGGLE = 'What each level asks about'
LEVEL_TABLE = [
 ('Read email, calendar and files it was given', 'AGGG'), ('Write in its own folder', 'GGGG'), ('Draft a reply', 'AGGG'), ('Run an ordinary command', 'AGGG'),
 ('A command that looks destructive inside its folder, or may wait for input', 'AAGG'), ('Email or message someone it has written to before', 'AGGG'),
 ('Email someone new, or post in public', 'AAAG'), ('Delete outside its own folder, on GitHub or in a database', 'AAAG'), ('Pay for anything', 'AAAG'),
 ('Contact another bot (when "Ask me before contacting other bots" is on)', 'AAGG'), ('Read your keys and passwords', 'AAAG'), ('A command that could wipe this computer', 'AAAA'),
]
LEVEL_ORDER = ['Ask', 'Auto', 'Full access', 'No limits']
def level_diff(a, b):
    """Rows that ask at level a and go ahead at level b: what really changes when a bot is raised."""
    i, j = LEVEL_ORDER.index(a), LEVEL_ORDER.index(b)
    return [r for r, c in LEVEL_TABLE if c[i] == 'A' and c[j] == 'G']
def level_still(b):
    j = LEVEL_ORDER.index(b); return [r for r, c in LEVEL_TABLE if c[j] == 'A']
# Which turns No limits covers: noLimitsAppliesTo (server/no-limits-origin.ts:19-29), decisionNoLimitsOrigin (server/index.ts:2521-2535), and the chat's own level
# (server/store.ts:6113: an explicit chat level wins over the bot's; decisionLiveLevel server/index.ts:2536-2566). In a guest chat the bot has no connected apps at all
# (server/store.ts:6114; server/connector-requests.ts:228-239).
NL_COVERS = ['Your own messages', 'Your messages from a messaging app, while Channel messages is on for the bot',
             "The bot's routines, run by hand or on schedule", 'Trigger links from other apps', 'Work your other bots hand to it']
NL_NEVER = ['A chat or routine you set to a lower level. It runs at that level, and the app choices saved for the bot apply there',
            'A chat with a guest or another person in it. It stays at Ask, and bots cannot use your connected apps there',
            'A bot that may only draft', 'A turn Murage cannot prove is yours']
GUEST_APPS = 'In a chat with a guest, bots cannot use your connected apps.'
FOLLOW = ['Juno', 'Mira', 'Otto', 'Vera']           # no level set by the owner: they keep the level they were made with, and only No limits moves them live (server/permission-inheritance.ts:17-30)
FOLLOW_ROUTINES = 2
NL_CHATS = [('Dax', 'Q4 board pack')]           # v8 (Astra r7 C1): one owner chat set to No limits on a bot at Ask. It is part of a new app's audience
# v10 (Astra r9 H3a): every routine and chat with a level of its own, as G1's buildNoLimitsPlan returns them. Move all names each one with the level it loses.
# (name, bot, own level, note)
MOVE_ROUTINES = [('Morning brief', 'Chief', 'Ask', 'It was waiting for you to approve Auto, and that request is withdrawn.'), ('Invoice chase', 'Atlas', 'Auto', ''),
                 ('Lead digest', 'Nova', 'Full access', ''), ('Ticket triage', 'Rhea', 'Auto', ''), ('Month-end close', 'Finn', 'Full access', ''), ('Weekly report', 'Sable', 'Ask', '')]
# (chat, bot, own level, guest?). The first is NL_CHATS[0].
MOVE_CHATS = [(chat, bot, 'No limits', False) for bot, chat in NL_CHATS] + [
    ('Payroll questions', 'Atlas', 'Full access', False), ('Hiring plan', 'Chief', 'Auto', False), ('Shop front', 'Kit', 'Ask', True)]
NOLIMITS = ['Pepper']                               # the only bot at No limits; the No limits banner is drawn on Pepper, never on Dax
# v7 (Walk r6 H3b): every bot has a stated app state, and the shipped default is honoured: a bot with nothing saved is Every app (server/bot-access-role.ts:9).
EVERY_APP = ['Sable', 'Kit', 'Rhea', 'Finn', 'Bram', 'Lux', 'Tess', 'Odin', 'Wren', 'Cato', 'Zia', 'Hugo']   # nothing saved: "Every app, including ones you add later"
def every_line(k=3): return ', '.join(EVERY_APP[:k]) + f' and {len(EVERY_APP) - k} more'
SEARCH_OFF = ['Sable', 'Kit']                       # Web search off for these two
ARCHIVED = [('Old Dax', 'Inbox assistant'), ('Trial bot', 'Research')]

def _bot(i):
    n = NAMES[i]
    lvl = 'No limits' if n in NOLIMITS else (NEW_LEVEL if n in FOLLOW else _LV[i % 6])
    return dict(n=n, role=ROLES[i % 8], eng=ENG[i % 6][0], model=ENG[i % 6][1], lvl=lvl, follows=n in FOLLOW,
                av=(n[0], f'c{i % 5 + 1}' if i % 5 else ''), tools=13 + i % 5, last=['Now', '2 h ago', 'Today', 'Yesterday', '3 days ago'][i % 5])
BOTS = [_bot(i) for i in range(39)]
N = len(BOTS)                                       # 39 bots. Archived bots are counted apart: 2.
NA = len(ARCHIVED)
def B(name): return BOTS[NAMES.index(name)]
ENGINE_COUNT = {k: sum(1 for b in BOTS if b['eng'] == k) for k in ('Fuigo', 'Claude Code', 'Codex')}   # 20 / 13 / 6

# ---- the 21 tools (catalog rows), and what works now for Dax ----
# (name, group, on for Dax now?, bots that can use it of 39 or None)
TOOLS = [
 ('Web search', 'b', True, N - len(SEARCH_OFF)), ('Read web pages', 'b', True, N), ('Images', 'b', False, 12), ('Voice notes', 'b', True, N),
 ('Browser', 'b', True, 9), ('Computer', 'b', False, 4), ('Files and shell', 'b', True, None), ('Memory', 'b', True, N),
 ('Past chats', 'b', True, N), ('Routines', 'b', True, N), ('Talk to other bots', 'b', True, None), ('Skills', 'b', True, None),
 ('Publish a site', 'b', True, None), ('Projects and channels', 'b', True, None),
 ('Connected apps', 'y', True, None), ('Bot email', 'y', False, None), ('Custom tools (MCP)', 'y', False, None),   # Dax is set to Only chosen apps, so it does not get the owner's tool servers (server/mcp-relay.ts:59-70)
 ('Messaging', 'y', False, None),
 ('Phone tools', 'y', False, None), ('Calls', 'y', True, None), ('Let other programs use a bot', 'y', False, None),
]
NT = len(TOOLS)                                     # 21
TOOL_BOTS = {t[0]: t[3] for t in TOOLS}
DAX_TOOLS = sum(1 for t in TOOLS if t[2])           # tools that work now for Dax
APP_TOOLS_OFF = ['Phone tools', 'Let other programs use a bot']   # the two rows that are off for every bot
APP_TOOLS_ON = NT - len(APP_TOOLS_OFF)             # app-wide: rows whose switch or setup is on

# ---- connected apps ----
LEVELS3 = ['No access', 'Read only', 'Read and change']
READ_KNOWN = ['Gmail', 'Google Calendar', 'Slack', 'Notion']   # Read only is offered where Murage has a reviewed list of the app's read operations: ten apps today (shared/connected-app-read-tools.ts:34-129; AG0 D3)
READ_KNOWN_ALL = 'Gmail, Google Calendar, Slack, Notion, Google Drive, GitHub, Linear, Zendesk, Intercom and Help Scout'
# app -> (account, state, {bot: saved level}); bots in EVERY_APP get Read and change unless an entry says otherwise
APPS = {
 'Gmail':           dict(acct='you@example.com', state='Signed in', mark='M', id='gmail', saved={'Chief': 'Read and change', 'Dax': 'Read and change'}),
 'Google Calendar': dict(acct='you@example.com', state='Signed in', mark='C', id='gcal', saved={'Chief': 'Read and change', 'Dax': 'Read and change', 'Juno': 'Read only', 'Atlas': 'Read only', 'Mira': 'Read only'}),
 'Notion':          dict(acct='Acme workspace', state='Needs sign-in', mark='N', id='notion', saved={'Dax': 'Read and change', 'Pepper': 'Read and change'}),
 'Slack':           dict(acct='acme.slack.com', state='Signed in', mark='S', id='slack', saved={'Chief': 'Read and change'}),
}
def apps_state(bot):
    """'chosen' = a saved record (Only chosen apps); 'every' = nothing saved, the shipped default; 'off' = Connected apps switched off for the bot. No fourth state exists."""
    if any(bot in v['saved'] for v in APPS.values()): return 'chosen'
    return 'every' if bot in EVERY_APP else 'off'
def app_saved(app, bot):
    s = APPS[app]['saved'].get(bot)
    if s: return s
    return 'Read and change' if bot in EVERY_APP else 'No access'
def has_saved(bot): return any(bot in v['saved'] for v in APPS.values())   # a bot with saved app choices: a model or role change clears them (server/bot-access-role.ts:4-12)
SAVED_BOTS = None
def nl_extra(app):
    """Bots at No limits that can use the app now although their saved level is No access."""
    return [n for n in NOLIMITS if APPS[app]['state'] == 'Signed in' and app_saved(app, n) == 'No access']
def can_line(app):
    x = nl_extra(app)
    return f'{app_count(app)} of {N}' + (f', and {" and ".join(x)} at No limits' if x else '')
def app_bots(app): return [b['n'] for b in BOTS if app_saved(app, b['n']) != 'No access']
def app_count(app): return len(app_bots(app))
def plural(n, w='bot'): return f'{n} {w}' + ('' if n == 1 else 's')
APPS_LINE = ' '.join(f'{a}: {plural(app_count(a))}.' for a in APPS)

# ---- Dax ----
DAX = dict(
 name='Dax', role='Inbox assistant', engine='Claude Code', model='Claude Sonnet', model_was='Claude Opus', model_changed='Yesterday 16:02', apps_set='Today 08:50', effort='Medium', level='Ask',
 apps_mode='Only chosen apps', writes=False,          # "Let Dax send, create and delete in your apps": Off
 voice='Juniper', voice_service='ElevenLabs', routines=2, memories=12, talks_to=['Chief', 'Pepper', 'Juno'],
 skills=[('Invoice chase', True), ('Weekly report', True)],   # v7: the Chief-only built-in is no longer drawn as a Dax switch (server/skills-api.ts:147)
 folder='~/Work/inbox', spend='$9.10', email='dax@you.murage.email',
 request=dict(by='Chief', app='Slack', acct='acme.slack.com', what='Send messages', writes=True, at='09:14'),
)
DAX['skills_on'] = sum(1 for _, on in DAX['skills'] if on)
def dax_app(app):
    """(saved, works now, why, fix label, fix href) for Dax and one app. The same answer on every page."""
    saved = app_saved(app, 'Dax')
    if APPS[app]['state'] != 'Signed in':
        return saved, 'Nothing', f'{app} needs you to sign in again.', f'Sign in to {app} again', f'apps.html#apps.connected.{APPS[app]["id"]}'
    if saved == 'Read and change' and not DAX['writes']:
        return saved, 'Read only', 'Changes in your apps are off for Dax.', 'Turn on changes in your apps', 'bot-tools-apps.html#bot.tools.apps.writes'
    return saved, saved, '', '', ''

# ---- What Dax can reach: one row per capability. (state, capability, first blocker or fact, fix label, href = the exact leaf) ----
REACH = [
 ('blocked', 'Send email from its own address', 'Its own email address is off for Dax.', 'Turn it on', 'bot-tools.html#bot.tools.email'),
 ('blocked', 'Use Notion', dax_app('Notion')[2], dax_app('Notion')[3], dax_app('Notion')[4]),
 ('blocked', 'Send from Gmail', 'Saved as Read and change. ' + dax_app('Gmail')[2] + ' It can only read.', dax_app('Gmail')[3], dax_app('Gmail')[4]),
 ('blocked', 'Change Google Calendar', 'Saved as Read and change. ' + dax_app('Google Calendar')[2] + ' It can only read.', dax_app('Google Calendar')[3], dax_app('Google Calendar')[4]),
 ('blocked', 'Make images', 'Images is off for Dax.', 'Turn on Images for Dax', 'bot-tools.html#bot.tools.images'),
 ('blocked', 'Use your phone', 'Phone tools is off for every bot.', 'Turn on Phone tools', 'phone.html#phone.features.phonetools'),
 ('blocked', 'Phone a business', 'Calls your bots make is not set up.', 'Set up calls', 'phone.html#phone.calls.botsmake'),
 ('blocked', 'Use a computer', 'Computer is off for Dax.', 'Choose a computer for Dax', 'bot-tools.html#bot.tools.computer'),
 ('blocked', 'Use your custom tools', 'Dax is set to Only chosen apps. Custom tools go to bots set to Every app, and to any bot on a No limits turn.', 'Change which apps Dax may use', 'bot-tools-apps.html#bot.tools.apps.mode'),
 ('asks', 'Use the browser', 'Asks you once per task when it drives your Chrome.', 'Change when it asks', 'bot-tools.html#bot.tools.browser'),
 ('asks', 'Work in files and run commands', 'Approval level is Ask. ' + LEVEL_MEANING['Ask'], 'See what each level asks about', 'bot-approvals.html#bot.approvals.table'),
 ('asks', 'Contact other bots', 'Asks you before contacting another bot.', 'Change when it asks', 'bot-approvals.html#bot.approvals.askbots'),
 ('asks', 'Publish a site', 'Publishing always asks you.', 'See published sites', 'bot-tools.html#bot.tools.sites'),
 ('ok', 'Search the web', "Murage's web search.", 'Tools', 'bot-tools.html#bot.tools.websearch'),
 ('ok', 'Read web pages', '', 'Tools', 'bot-tools.html#bot.tools.webread'),
 ('ok', 'Read Gmail', 'you@example.com. Read only.', 'Gmail', 'apps-gmail.html#apps.connected.bots'),
 ('ok', 'Read Google Calendar', 'you@example.com. Read only.', 'Google Calendar', 'apps.html#apps.connected.gcal'),
 ('ok', 'Remember things', 'Memory and learning are on. 12 memories.', 'Memory & learning', 'bot-memory.html#bot.memory.managed'),
 ('ok', 'Look up past chats', '', 'Tools', 'bot-tools.html#bot.tools.pastchats'),
 ('ok', 'Run routines', '2 routines.', 'Routines', 'bot-routines.html#bot.routines.list'),
 ('ok', 'Send voice notes', 'Voice: Juniper.', 'Voice & notifications', 'bot-voice.html#bot.voice.voice'),
 ('ok', 'Call you when it is urgent', 'Calls today are on. Not in quiet hours.', 'Voice & notifications', 'bot-voice.html#bot.voice.calls'),
 ('ok', 'Use its skills', '2 skills.', 'Skills', 'bot-skills.html#bot.skills.list'),
]
RC = {k: sum(1 for r in REACH if r[0] == k) for k in ('blocked', 'asks', 'ok')}
REACH_LINE = f'Cannot: {RC["blocked"]}. Asks first: {RC["asks"]}. Can: {RC["ok"]}.'

OWNER = dict(name='Alex', email='you@example.com', zone='Miami (UTC-5)', quiet='22:00 to 08:00', calls_today=True, memories_about_you=9, memories_all=214)
SAVED_BOTS = [b['n'] for b in BOTS if has_saved(b['n'])]
APPS_OFF = [b['n'] for b in BOTS if apps_state(b['n']) == 'off']      # Connected apps switched off for the bot: no record, so a model change clears nothing
assert len(SAVED_BOTS) + len(EVERY_APP) + len(APPS_OFF) == N and not (set(SAVED_BOTS) & set(EVERY_APP))
NEEDS_YOU = 3          # Notion sign-in; Chief's app request for Dax; Codex needs sign-in (6 bots wait)
def _by_bot():
    """v7 (Walk r6 H3a): all 39 per-bot amounts, highest first, adding up to the cent to the FluxRouter total."""
    top = {'Chief': 1840, 'Dax': 910, 'Pepper': 630}; rest = [n for n in NAMES if n not in top]; left = 4120 - sum(top.values())
    w = [len(rest) - k for k in range(len(rest))]; c = [max(1, left * x // sum(w)) for x in w]; c[0] += left - sum(c)
    return sorted(list(top.items()) + list(zip(rest, c)), key=lambda t: -t[1])
SPEND = dict(flux='$41.20', keys='About $12', limit='$100', by_bot=[(n, c / 100) for n, c in _by_bot()],
             by_tool=[('Models', 31.60), ('Images', 5.20), ('Voice', 2.90), ('Web search', 1.50)])
assert round(sum(a for _, a in SPEND['by_bot']) * 100) == 4120 and round(sum(a for _, a in SPEND['by_tool']) * 100) == 4120
# v7: skills at library scale (settings-skills-study/SKILLS-STUDY.md sections 1.1, 1.7, 6; counted on dev/1021 at 613ea4702e).
SK = dict(library=2247, builtin=4, yours=11, all=2262, on_a_bot=31, review=41, cats=33, cap_bytes='4,000', cap_lines=30,
          chief_on=11, chief_listed=6, team=('Front office', ['Chief', 'Dax', 'Juno']))
assert SK['library'] + SK['builtin'] + SK['yours'] == SK['all']
SK_CATS = [('Software engineering', 177), ('Writing', 162), ('Business strategy', 149), ('Health and wellness', 135), ('Education', 126), ('Productivity', 117),
           ('Home and household', 102), ('Design and creative', 99)]
# v7 (Astra r6 4): engines whose own page reader Murage cannot switch off, from the routing table at the tip (shared/web-read-routing.ts:19-32, the rows with a limitation).
READERS_NO_SWITCH = ['Kimi Code', 'Cursor', 'Cline', 'Command Code', 'Kiro', 'OMP', 'DeepSeek Harness', 'Muse Code', 'Antigravity', 'OpenClaw', 'Box Agent']
# v7 (Astra r6 14): Codex has its own sign-in. The CLI reports subscription, metered (API key), signed out or unknown (server/drivers/codex.ts:469-474, :3330-3343).
CODEX = dict(state='signed-out', line='Codex needs its own sign-in. The OpenAI key saved in Murage does not sign Codex in.')
def model_prose(b): return f'{b["eng"]}, model picked for you' if b['model'] == AUTO_MODEL else f'{b["eng"]}, {b["model"]}'
DEVICES = [('Pixel 9', 'Murage app on Android 15', 'Connected now', 'phone'), ('iPhone', 'Safari on iPhone. Browser.', '2 minutes ago', 'phone'),
           ('MacBook Air', 'Chrome on Mac. Browser.', 'Yesterday', 'computer')]
BACKUP = dict(last='today 02:00', size='1.8 GB', count=14, key_made='2 Nov', folder='/Volumes/Backups/Murage')

# ---- the fixture table (also printed into IA-PROPOSAL-v5.md, section 3) ----
def table():
    g, c = dax_app('Gmail'), dax_app('Google Calendar')
    return [
     ('Bots', f'{N} bots. {NA} archived, counted apart ({N + NA} rows in the Bots list).', 'bots.html, overview.html, every "of 39"'),
     ('Engines', f'Fuigo {ENGINE_COUNT["Fuigo"]}, Claude Code {ENGINE_COUNT["Claude Code"]}, Codex {ENGINE_COUNT["Codex"]} (needs sign-in).', 'engines.html, models.html, bots.html'),
     ('Tools, app-wide', f'{APP_TOOLS_ON} of {NT} on.', 'overview.html, tools.html'),
     ('Tools, Dax', f'Dax can use {DAX_TOOLS} of {NT} tools.', 'bot-tools.html, bots.html row, deep-link.html, layouts'),
     ('Dax: engine and model', f'{DAX["engine"]}, {DAX["model"]}. Changed from {DAX["model_was"]} {DAX["model_changed"].lower()}, which cleared its app choices. They were chosen again {DAX["apps_set"].lower()}.', 'bot-model.html, bot-profile.html, bots.html, models.html, overview.html journal'),
     ('Dax: approval level', DAX['level'], 'bot-approvals.html, bot-profile.html, bot-reach.html, bots.html row'),
     ('Dax: apps', f'{DAX["apps_mode"]}. Changes in your apps: Off.', 'bot-tools-apps.html, bot-tools.html'),
     ('Dax: Gmail', f'Saved {g[0]}. Works now {g[1]}.', 'bot-reach.html, bot-tools.html, bot-tools-apps.html, apps-gmail.html'),
     ('Dax: Google Calendar', f'Saved {c[0]}. Works now {c[1]}.', 'bot-reach.html, bot-tools.html, bot-tools-apps.html'),
     ('Dax: Notion', f'Saved {dax_app("Notion")[0]}. Works now {dax_app("Notion")[1]} (Notion needs sign-in).', 'bot-reach.html, bot-tools.html, bot-tools-apps.html'),
     ('Dax: waiting request', 'Chief asked to give Dax Slack (acme.slack.com): Send messages, with changes on. 09:14.', 'bot-tools.html, bot-tools-apps.html, overview.html'),
     ('Dax: what it can reach', REACH_LINE + ' Capabilities, not tools: no "of 21".', 'bot-reach.html, bot-profile.html'),
     ('Dax: skills, routines, memory', f'{DAX["skills_on"]} skills on. {DAX["routines"]} routines. {DAX["memories"]} memories.', 'bot-skills.html, bot-routines.html, bot-memory.html, bot-reach.html'),
     ('Apps', APPS_LINE, 'apps.html, tools.html, app sheets'),
     ('Every app (new apps too)', f'{len(EVERY_APP)} bots with nothing saved: ' + ', '.join(EVERY_APP) + '.', 'apps.html (Add an app), app sheets'),
     ('Connected apps off for the bot', f'{len(APPS_OFF)} bots: ' + ', '.join(APPS_OFF) + '. Nothing is saved for them, so a model change clears nothing.', 'app sheets, models.html'),
     ('Only chosen apps', ', '.join(SAVED_BOTS) + '. No bot is drawn at No access with nothing saved.', 'app sheets'),
     ('No limits', ', '.join(NOLIMITS) + '. Dax is never drawn at No limits.', 'bot-reach-nolimits.html, bots.html row'),
     ('Approval levels, one meaning each', ' '.join(f'{k}: {v}' for k, v in LEVEL_MEANING.items()), 'bot-approvals.html, bot-reach.html, bot-tools.html, help.html'),
     ('Bots with saved app choices', ', '.join(SAVED_BOTS) + '. Changing the engine, model, thinking effort, provider account, title, role, purpose or section clears them. So does archiving.', 'models.html, bot-model.html, bot-profile.html'),
     ('Dax: thinking effort', DAX['effort'] + ' on every page.', 'bot-model.html, models.html'),
     ('New bots start with', f'{NEW_LEVEL}. No level set by you: {", ".join(FOLLOW)} and {FOLLOW_ROUTINES} routines. Only No limits moves them.', 'bots.html'),
     ('Web search', f'{TOOL_BOTS["Web search"]} of {N} bots. Off for {" and ".join(SEARCH_OFF)}. Search with: Engine\'s own search first.', 'tools.html, tools-websearch.html'),
     ('Needs you', f'{NEEDS_YOU}: Notion sign-in; the Slack request for Dax; Codex sign-in (6 bots wait).', 'overview.html, rail markers'),
     ('Calls today', 'On. Quiet hours 22:00 to 08:00.', 'phone.html, layout-phone.html, bot-voice.html, bot-reach.html'),
     ('Spend', f'FluxRouter {SPEND["flux"]} this month; limit {SPEND["limit"]}; Dax {DAX["spend"]}. The {N} per-bot amounts and the four per-tool amounts each add up to {SPEND["flux"]}.', 'usage.html, bot-activity.html'),
     ('Skills', f'{SK["all"]:,} skills: {SK["library"]:,} in the library, {SK["builtin"]} built in, {SK["yours"]} yours. {SK["on_a_bot"]} are on at least one bot. {SK["review"]} need a look. Dax has {DAX["skills_on"]} on, both in every message. Chief has {SK["chief_on"]} on, {SK["chief_listed"]} in every message.', 'skills.html, skills-advanced.html, skills-sheet.html, bot-skills.html, bot-skills-chief.html'),
     ('Approval level table', f'{len(LEVEL_TABLE)} rows, word for word from the shipped table.', 'bot-approvals.html, help.html'),
     ('Codex', 'Not signed in. ' + CODEX['line'], 'providers.html, engines.html, states.html'),
     ('Page readers Murage cannot switch off', ', '.join(READERS_NO_SWITCH) + ', and any custom agent.', 'tools-websearch.html'),
     ('Backups', f'Last {BACKUP["last"]}, {BACKUP["size"]}. Recovery key made {BACKUP["key_made"]}.', 'backups.html and its sheets'),
    ]
