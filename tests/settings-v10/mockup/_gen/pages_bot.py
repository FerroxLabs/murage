# One bot's settings: 12 rail pages, each at 1440 x 900. The bot is Dax. Every value comes from fixture.py.
from core import *
import core, fixture as F
from pages_app import BOTS, avr, CAT
D = F.DAX

# ---------------- What it can reach ----------------
def reach_body():
    def rows(kind):
        out = ''
        for k, cap, why, fix, href in F.REACH:
            if k != kind: continue
            if k == 'blocked': out += R(cap, why, icon='x', cls='why', st=('', 'Cannot'), go=('Fix: ' + fix, href))
            elif k == 'asks': out += R(cap, why, icon='shield', cls='why', st=('', 'Asks first'), go=(fix, href))
            else: out += R(cap, why, icon='check', st=('ok', 'Can'), go=('Open ' + fix, href))
        return out
    return (S(f'Cannot yet ({F.RC["blocked"]})', rows('blocked'), sub='The first thing in the way, and the one place to fix it', scope='Only Dax', id='bot.reach.blocked') +
            S(f'Asks you first ({F.RC["asks"]})', rows('asks'), scope='Only Dax', id='bot.reach.asks') +
            S(f'Can do now ({F.RC["ok"]})', rows('ok'), scope='Only Dax', id='bot.reach.ok'))

def reach_nolimits_body():
    cov = ''.join(R(t, '', icon='check', st=('ok', 'No limits')) for t in F.NL_COVERS)
    nev = ''.join(R(t, '', icon='shield', cls='why', st=('', 'Usual rules')) for t in F.NL_NEVER)
    return (S('Which turns run at No limits', cov, scope='Only Pepper', sub='In a chat that is yours alone', id='bot.reach.nolimits.covers') +
            S('Which turns never do', nev, scope='Only Pepper', sub='These run at their own level, with the usual rules', id='bot.reach.nolimits.never') +
            S('Cannot yet (1)', R('Use Notion', 'Notion needs you to sign in again.', icon='x', cls='why', st=('', 'Cannot'), go=('Fix: Sign in to Notion again', 'apps.html#apps.connected.notion')), scope='Only Pepper') +
            S('Asks you first (1)', R('Run a command that would wipe data', 'Always asks, at every approval level.', icon='shield', cls='why', st=('', 'Asks first')), scope='Only Pepper',
              post='<p class="hint">A question Pepper puts to you is not an approval: Pepper waits for your answer and then carries on.</p>') +
            S('Can do now, at No limits (4)', R('Use Gmail', 'Saved: No access. At No limits the saved app choices are not applied, so Pepper can read and change Gmail.', icon='check', cls='why', st=('ok', 'Can'),
                                                 go=('Open Gmail', 'apps-gmail.html#apps.connected.bots')),
              R('Use Slack and Google Calendar', 'Saved: No access. The same applies.', icon='check', st=('ok', 'Can'), go=('Open Connected apps', 'apps.html#apps.connected')),
              R('Use your custom tools', 'Pepper is set to Only chosen apps, which normally leaves custom tools out. On a No limits turn it gets them.', icon='check', cls='why', st=('ok', 'Can'), go=('Open Connected apps', 'apps.html#apps.mcp')),
              R('Work in files and run commands', 'Does not stop to ask.', icon='check', st=('ok', 'Can'), go=('Open Approvals', 'bot-approvals.html#bot.approvals.level')), scope='Only Pepper'))

def nolimits_banner():
    return ban('<b>Pepper is at No limits.</b> In a chat that is yours alone it does not stop to ask, and the app choices saved for it are not applied. '
               'That covers your own messages, its routines, trigger links from other apps, and work your other bots hand to it. '
               'A chat or routine you set to a lower level runs at that level, and the saved app choices apply there. ' + F.GUEST_APPS + ' Three things still hold everywhere: '
               'Connected apps switched off for Pepper stays off. A command that would wipe data always asks. A question Pepper asks you still waits for your answer.',
               'note', lnk('Approvals', 'bot-approvals.html#bot.approvals.level'))

# ---------------- Profile ----------------
def profile_body():
    g = S('At a glance', R('Engine and model', f'{D["engine"]}, {D["model"]}.', icon='model', ref='bot.model.model', go=('Engine & model', 'bot-model.html#bot.model.model')),
          R('What it can reach', F.REACH_LINE, icon='check', go=('What it can reach', 'bot-reach.html')),
          R('Approval level', D['level'] + '.', icon='shield', ref='bot.approvals.level', go=('Approvals', 'bot-approvals.html#bot.approvals.level')), scope='Only Dax')
    who = S('Who it is', R('Name', rawdesc=saved(), icon=None, id='bot.profile.name', end=inp('Dax', label='Name')), R('Title', 'Shown under the name everywhere.', id='bot.profile.title', end=inp(D['role'], label='Title')),
            R('Look', 'Blue, letter D.', id='bot.profile.look', open=True), R('Role', 'What Murage sets it up as: Assistant or Chief of staff.', id='bot.profile.role', val='Assistant'),
            R('Replies in', 'The language Dax answers in.', id='bot.profile.replylanguage', val='The app language (English)', tg=[('New',)]),
            R('What is this bot for?', 'One line Dax reads about its job: Sorts your inbox and drafts replies.', id='bot.profile.purpose', open=True),
            R('Personality', 'Calm, brief, a little dry.', id='bot.profile.personality', open=True),
            R('Instructions', 'What Dax is told to do.', ref='bot.instructions.text', go=('Instructions', 'bot-instructions.html#bot.instructions.text')),
            scope='Only Dax', sub='Text fields save when you leave them',
            post='<p class="hint" id="bot.profile.appsnote"><b>Changing Title, Role, What is this bot for or Section clears the app choices saved for Dax.</b> So does archiving Dax. Dax goes to Only chosen apps with no apps, and changes in your apps turn off. A waiting app request ends. Murage asks first, names the apps (Gmail, Google Calendar, Notion), and asks again if they changed while the question was open. Name, Look, Replies in, Personality, Pin to the top and Show in the sidebar do not.</p>')
    sb = S('In the sidebar', R('Pin to the top', '', id='bot.profile.pinned', on=True), R('Show in the sidebar', 'Off: Dax still works and stays in Bots. Its app choices are kept.', id='bot.profile.sidebarhidden', on=True),
           R('Section', '', id='bot.profile.section', val='Work'), scope='Only Dax')
    rm = S('Archive or delete', R('Archive Dax', 'Hides Dax and stops its routines. Its chats, memory, routines and files are kept, and you can bring it back from Bots. Its saved app choices are not kept: Dax comes back set to Only chosen apps with no apps.', icon='backup', cls='why',
                                 act=A('Archive', 'bot.profile.archive', 'sm', 'Archive writes hidden (src/components/Sidebar.tsx:2527-2530), which is part of the access role binding (server/bot-access-role.ts:5), so the saved app choices are cleared and bringing the bot back does not restore them. The confirmation names the apps and carries the access revision it showed. Show in the sidebar writes sidebarHidden, a presentation field (Sidebar.tsx:2543-2553; server/store.ts:1180-1181), and clears nothing.')),
           R('Delete Dax', 'Removes Dax, its chats, memory and routines for good. A backup is the only way back.', icon='x', cls='why',
             act=A('Delete this bot', 'bot.profile.delete', 'sm dng', 'Confirmation says what is lost and asks you to type the name. In the main column, not the aside.')), scope='Only Dax', id='bot.profile.remove')
    return g + who + sb + rm

def instructions_body():
    return (S('Instructions', f'<div class="editor"><textarea class="ta tall" aria-label="Instructions for Dax" id="bot.instructions.text" data-id="bot.instructions.text">You sort my inbox every morning. Draft replies for anything from a customer. Never send without showing me.</textarea><div class="sfoot"><span class="inh">Saved today 08:40</span>{B("Save", "pri")}</div></div>', scope='Only Dax')
            + S('What shapes this bot', R('House rules', 'Included.', icon='rules', id='bot.instructions.houserules', on=True), R('About you', 'Included. What every bot should know about you.', icon='user', id='bot.instructions.aboutme', on=True),
                R('Team brief', 'The shared note for the bots in its team. Left out for Dax.', icon='team', id='bot.instructions.teambrief', on=False),
                R('Personality', 'Set on Profile.', icon='pencil', ref='bot.profile.personality', go=('Profile', 'bot-profile.html#bot.profile.personality')), scope='Only Dax', id='bot.instructions.shapes'))

def model_body():
    return (S('Engine and model', R('Engine', f'What runs Dax. Using your Claude plan. Choosing an engine opens its models; nothing changes until you pick a model.', icon='eng', id='bot.model.engine', val=D['engine'], cls='why'),
              R('Model', f'Which model Dax uses. Changed from {D["model_was"]} {D["model_changed"].lower()}.', icon='model', id='bot.model.model', val=D['model']),
              R('Thinking effort', 'Higher is slower and more careful. Changing it clears the app choices saved for Dax, like a model change.', icon='sliders', id='bot.model.effort', end=seg(['Low', 'Medium', 'High'], D['effort'], 'Thinking effort'), cls='why'),
              scope='Only Dax', more=['When the plan runs out'], advids=[('bot.model.atlimit', 'When the plan runs out')],
              post='<p class="hint" id="bot.model.appsnote">Saved appears after your computer confirms the change.</p>' + ban('<b>Changing the engine, model or thinking effort clears the app choices saved for Dax.</b> So does changing which provider account the engine uses. Dax goes to Only chosen apps with no apps, changes in your apps turn off, and a waiting app request ends. Changing it back does not bring them back. Murage asks before it saves and names the apps: Gmail, Google Calendar, Notion. If Murage itself has to move Dax to another model, because the model was withdrawn or the engine was replaced, the same happens and Changed recently says so.', 'note', lnk('Gmail and other apps', 'bot-tools-apps.html#bot.tools.apps.mode')))
            + S('Related', R('Engines you can choose from', '2 ready, 1 needs sign-in.', icon='eng', go=('Engines', 'engines.html')), R('Change several bots at once', 'Tick bots in one table, then apply.', icon='bots', go=('Models', 'models.html#models.table'))))

# ---------------- Tools ----------------
def _apps_desc():
    out = []
    for a in F.APPS:
        sv, eff, why, fix, href = F.dax_app(a)
        if sv == 'No access': continue
        out.append(f'{a}: {eff.lower()}' + (f' (saved: {sv})' if eff != sv and eff != 'Nothing' else '') + (' until you sign in again' if eff == 'Nothing' else ''))
    return '. '.join(out) + '.'
BT = {'Web search': (True, "Murage's web search. Off also stops Claude Code's own search for Dax.", 'bot.tools.websearch'),
      'Read web pages': (True, 'Murage opens links and reads them.', 'bot.tools.webread'), 'Images': (False, 'Off for Dax.', 'bot.tools.images'),
      'Voice notes': (True, f'Voice: {D["voice"]}.', 'bot.tools.voicenotes'), 'Past chats': (True, '', 'bot.tools.pastchats'), 'Routines': (True, f'{D["routines"]} routines.', 'bot.tools.routines')}
def bot_tools_body(phone=False):
    # v8 (Fable r7 H1): on a paired phone every per-bot tool switch, the Connected apps switch and the app access read are desktop class
    # (PATCH /api/bots/:id and GET/PUT /api/bots/:id/access, server/route-policy.ts:398-399). The phone draws each row's value with
    # "Change this on your computer" and mounts no switch and no sheet opener (X1 allowlist).
    if phone:
        def R(t, d='', **k):
            on = k.pop('on', None); k.pop('open', None); k.pop('end', None); i = k.pop('id', None)
            if on is not None: k['st'] = ('t', 'On' if on else 'Off')
            if i == 'bot.tools.phone': k.pop('go', None)
            if on is not None or i: d = (d + ' ' if d else '') + 'Change this on your computer.'
            return core.R(t, d, **k)
    else:
        R = core.R
    b1 = ''
    for t, d, i, idd, kind, x in CAT[0][1]:
        if t == 'Voice notes': b1 += R(t, BT[t][1], icon=i, id=BT[t][2], on=True, end=lnk('Change voice', 'bot-voice.html#bot.voice.voice'))
        elif t in BT:
            on, dd, bid = BT[t]; b1 += R(t, dd, icon=i, id=bid, on=on, cls='' if on else 'off')
        elif t == 'Browser': b1 += R('Browser', 'Its own browser. Asks once per task only when it drives your Chrome.', icon=i, id='bot.tools.browser', on=True, open=True)
        elif t == 'Computer': b1 += R('Computer', 'Off for Dax. Choices: Auto, This Mac, Virtual computer, Murage Cloud computer, Browser only, Off.', icon=i, id='bot.tools.computer', open=True)
        elif t == 'Files and shell': b1 += R('Files and shell', f'Working folder: {D["folder"]}. At Ask, Dax writes there without asking and asks before each other action that needs your yes.', icon=i, id='bot.tools.workingfolder', open=True)
        elif t == 'Memory': b1 += R('Memory', 'On for Dax.', icon=i, ref='bot.memory.managed', go=('Memory & learning', 'bot-memory.html#bot.memory.managed'))
        elif t == 'Talk to other bots': b1 += R(t, f'May contact {len(D["talks_to"])} bots. Asks you first.', icon=i, ref='bot.approvals.cantalkto', go=('Approvals', 'bot-approvals.html#bot.approvals.cantalkto'))
        elif t == 'Skills': b1 += R(t, f'{D["skills_on"]} skills.', icon=i, go=('Skills', 'bot-skills.html#bot.skills.list'))
        elif t == 'Publish a site': b1 += R('Published sites', '1 site. Publishing always asks you.', icon=i, id='bot.tools.sites', open=True)
        elif t == 'Projects and channels': b1 += R(t, 'Member of 2 projects.', icon=i, go=('Rules for every bot', 'rules.html#rules.projects'))
    q = D['request']
    req = R('Gmail and other apps', _apps_desc(), icon='link', id='bot.tools.connectedapps', on=True, open='bot-tools-apps.html', cls='why')
    if phone: req = core.R('Gmail and other apps', 'Which apps Dax may use is set on your computer. This phone cannot see or change it.', icon='link', st=('', 'Computer only'))
    pend = R(f'{q["by"]} asked to give Dax {q["app"]}', f'{q["what"]} in {q["acct"]}. Approving replaces the app choices saved for Dax and turns changes in your apps on. Waiting since {q["at"]}.', icon='warn', cls='why', st=('warn', 'Needs you'),
             ref='bot.tools.apps.request', go=('Review the request', 'bot-tools-apps.html#bot.tools.apps.request'))
    if phone: pend = core.R('1 app request is waiting', 'Review it on your computer.', icon='warn', cls='why', st=('warn', 'Needs you'), go=('Where to review it', 'layout-phone-sheet.html'))
    b2 = (req + pend + R('Its own email address', f'Off for Dax. {D["email"]} is ready when you turn it on.', icon='mail', id='bot.tools.email', on=False, open=True, cls='off') +
          R('Custom tools (MCP)', 'Not for Dax, except in a chat you set to No limits. Custom tools go to bots set to Every app, and Dax is set to Only chosen apps.', icon='sliders', cls='why', ref='apps.mcp', go=('Connected apps', 'apps.html#apps.mcp')) +
          R('Messaging', 'Dax does not answer on a messaging app. Telegram goes to Chief.', icon='msg', ref='messaging.apps', go=('Messaging', 'messaging.html#messaging.apps')) +
          R('Phone tools', 'Off for every bot.', icon='phone', id='bot.tools.phone', st=('t', 'Off'), go=('Fix: Turn on Phone tools', 'phone.html#phone.features.phonetools')) +
          R('Calls', 'May call you when it is urgent.', icon='call', ref='bot.voice.calls', go=('Voice & notifications', 'bot-voice.html#bot.voice.calls')) +
          R('Let other programs use Dax', 'Off.', icon='terminal', ref='phone.scripts', go=('Phone & remote access', 'phone.html#phone.scripts')))
    return S('Built in', b1, scope='Only Dax', id='bot.tools.builtin') + S('Uses something of yours', b2, scope='Only Dax', id='bot.tools.yours')
TOOLS_SUB = f'Dax can use {F.DAX_TOOLS} of {F.NT} tools.'

def bot_apps_sheet():
    def idline(i, label, t, d, end):
        core._reg(i, label)
        return f'<div class="line" id="{i}" data-id="{i}"><span class="t">{t}<span class="d">{d}</span></span><span class="end">{end}</span></div>'
    apps = ''
    for a, v in F.APPS.items():
        sv, eff, why, fix, href = F.dax_app(a)
        note = f'Works now: <b>{eff}</b>.' + (f' {why} <a class="lnk" href="{href}">Fix: {fix}</a>' if why else '')
        if a == D['request']['app']: note = 'Works now: <b>No access</b>. A request is waiting below.'
        apps += idline(f'bot.tools.apps.{v["id"]}', f'{a} for Dax', f'{a}', note, pick(sv, f'{a} for Dax'))
    q = D['request']
    core._reg('bot.tools.apps.mode', 'Which apps Dax may use')
    mode = ('<div class="stack" id="bot.tools.apps.mode" data-id="bot.tools.apps.mode">' + seg(['Only chosen apps', 'Every app'], D['apps_mode'], 'Which apps') +
            '<p class="hint">Only chosen apps: an app you add later starts with no access for Dax, and Dax does not get your custom tools. Every app: Dax also gets each app you add later, and your custom tools. A chat you set to No limits is not held to either choice.</p></div>')
    return sheet('Gmail and other apps', 'What Dax may do in your connected apps. Each choice saves by itself.',
        lab('Which apps') + mode +
        idline('bot.tools.apps.writes', 'Let Dax send, create and delete in your apps', '<span id="ba1">Let Dax send, create and delete in your apps</span>',
               'Off: Dax can read, and cannot change anything, whatever is saved below.', sw(D['writes'], 'ba1')) +
        lab('Each app', 'What you saved, and what works now') + apps +
        '<div class="cost">Lowering access stops what Dax is doing right now, in every chat. If one of its chats is running at No limits, only the other chats are stopped. Raising it interrupts nothing: Dax gets it on its next message. ' + F.GUEST_APPS + '  Read only is offered for apps whose read actions Murage has checked: ' + F.READ_KNOWN_ALL + '.</div>' +
        lab('Waiting request', '1') + f'<div id="bot.tools.apps.request" data-id="bot.tools.apps.request">' +
        line(f'{q["by"]} asked to give Dax {q["app"]}', f'{q["what"]} in {q["acct"]}, with changes turned on. Asked at {q["at"]}.') +
        '<div class="cost"><b>If you approve:</b> the request replaces what is saved above. Dax keeps Slack only. Gmail, Google Calendar and Notion go to No access. Changes in your apps turn on. Dax is set to Only chosen apps. If Connected apps were off for Dax, approving also turns them on. If anything above changed since you opened this, Murage does not approve: it shows the new state and asks you to review again.</div>' +
        f'<div class="sfoot">{A("Decline", "bot.tools.apps.decline", "")}{A("Approve and replace", "bot.tools.apps.approve", "pri", "Shows what is replaced first. The shipped approve replaces mode, changes and grants with the request and turns Connected apps on for the bot (server/bot-access.ts:163, :176-181; shipped words BotAccessSettings.tsx:59-63). The same text and the same shown-revision check are on every place a request can be approved, the approval card included (AG0 addendum A6: one review identity, and an applied-request receipt written with the policy, so a restart never reports a committed approval as failed).")}</div></div>' +
        '<div class="advh">Advanced</div>' + idline('bot.tools.apps.operations', 'Exact operations', 'Exact operations', 'Gmail: read mail, read your profile. Send mail follows the switch above. Presets for an account, as today.', pick('Gmail', 'Choose an app to set exact operations')),
        'plug', 'bapps')

def approvals_body():
    def lv(t, d, on=False): return line(f'{rad(on, t)} <b>{t}</b>', d)
    core._reg('bot.approvals.level', 'Approval level')
    level = ('<div class="pad" role="radiogroup" aria-label="Approval level" id="bot.approvals.level" data-id="bot.approvals.level">' +
             ''.join(lv(k, v, D['level'] == k) for k, v in F.LEVEL_MEANING.items()) + '</div>' +
             '<p class="hint pad">This is the level Dax starts each new chat with. A chat can have its own level, lower or higher, set in that chat; changing the level here does not move those chats. No limits also covers the bot\'s routines, trigger links from other apps and work other bots hand it. A chat with a guest in it stays at Ask. Auto on this computer, Full access and No limits each ask you to review what changes before they save.</p>' +
             '<div class="card gap">' + leveltable() + '</div><p class="hint pad">Asks means Dax stops and waits for your yes. Things you have already said yes to for good are listed under Always allowed.</p>')
    return (S('Approval level', level, scope='Only Dax', sub='Tools: what Dax can use. Approvals: when Dax must ask first.', more=['Review ordinary approvals'])
            + S('Also asks', R('Browser', 'Once per task, when it drives your Chrome.', icon='window', ref='bot.tools.browser', go=('Tools', 'bot-tools.html#bot.tools.browser')),
                R('Email', 'Before each send.', icon='mail', ref='bot.tools.email', go=('Tools', 'bot-tools.html#bot.tools.email')),
                R('Images', 'Before each image.', icon='image', id='bot.approvals.images', val='Each time'), scope='Only Dax', sub='Browser and email are set with their tool. Images is set here.', id='bot.approvals.alsoasks')
            + S('Other bots', R('Can talk to', ', '.join(D['talks_to']) + '.', icon='team', id='bot.approvals.cantalkto', open=True), R('Ask you before contacting other bots', '', icon='shield', id='bot.approvals.askbots', on=True), scope='Only Dax')
            + S('Always allowed', R('3 things Dax no longer asks about', f'Run tests in {D["folder"]}, read your calendar, open docs.example.com.', icon='check', id='bot.approvals.always', open=True),
                R('Trusted folders', 'Shared by every bot.', icon='folder', ref='rules.saidyes.folders', go=('Rules for every bot', 'rules.html#rules.saidyes.folders')), scope='Only Dax'))

import pages_skills as PS
bskills_body = PS.bot_skills_body

MEMS = [('Prefers replies under five lines.', 'How you like things. From a chat on 12 Nov.'), ('Acme pays invoices on the 15th.', 'Fact. From a chat on 9 Nov.'),
        ('Never send to a customer without showing you first.', 'How you like things. From your instructions, 2 Nov.'), ('Your accountant is Rosa at Ledgerly.', 'Fact. From a chat on 6 Nov.')]
def bmemory_body(open_list=False):
    return (S('Memory', R('Memory for Dax', 'Dax remembers what you tell it.', icon='memory', id='bot.memory.managed', on=True),
              R('Learning', 'Dax also learns from how you work. Needs Memory on.', icon='memory', id='bot.memory.learning', on=True),
              R('What Dax remembers', f'{D["memories"]} memories. See, correct or forget any one.', icon='doc', id='bot.memory.list', open='bot-memory-list.html', cls='is-open' if open_list else ''),
              scope='Only Dax', more=['Carry over between chats', 'Older notebook'])
            + S('Start fresh', R(f'Start fresh for {core.BOTCTX["n"]}', f'Clears everything {core.BOTCTX["n"]} has learned. Shows what will go first. Chats are kept.', icon='restore', cls='why',
                                 act=A('Start fresh', 'bot.memory.startfresh', 'sm dng', 'A preview, then one confirmation. Visible in Simple: a destructive action is never reachable only through Advanced.')), scope='Only Dax')
            + S('Related', R('Memory for every bot', '', icon='memory', ref='memory.memory.mode', go=('Memory', 'memory.html#memory.memory.mode')),
                R('Everything your bots remember', '', icon='user', ref='memory.aboutyou', go=('Memory', 'memory.html#memory.aboutyou')),
                R('Learning limits', '', icon='usage', ref='usage.learning', go=('Usage & spend', 'usage.html#usage.learning'))))

def memlist(who, items, n, idp):
    rows = ''
    for k, (t, d) in enumerate(items):
        if k == 1:
            rows += (f'<div class="line memrow"><span class="t">{e(t)}<span class="d">Forget this for good? This memory and every earlier version of it are deleted and cannot be brought back. If it changes while this question is open, nothing is deleted and Murage shows you the new words first. Archive hides it and can be undone.</span></span>'
                     f'<span class="end">{B("Keep", "sm")}{B("Forget", "sm red")}</span></div>')
        else:
            if k == 2 and who == 'Dax':
                rows += (f'<div class="line memrow"><span class="t">{e(t)}<span class="d">Waiting for your yes. Dax wants this to replace "Show drafts to you first". Approving it makes it the memory Dax uses.</span></span>'
                         f'<span class="end"><button type="button" class="lnk" aria-label="Edit and approve: {e(t)}">Edit and approve</button><button type="button" class="btn sm" aria-label="Approve: {e(t)}">Approve</button><button type="button" class="btn sm" aria-label="Forget: {e(t)}">Forget</button></span></div>')
                continue
            rows += f'<div class="line memrow"><span class="t">{e(t)}<span class="d">{e(d)}</span></span><span class="end"><button type="button" class="lnk" aria-label="Correct: {e(t)}">Correct</button><button type="button" class="lnk" aria-label="Archive: {e(t)}">Archive</button><button type="button" class="btn sm" aria-label="Forget: {e(t)}">Forget</button></span></div>'
    scope = 'Dax' if who == 'Dax' else 'every bot'
    core._reg(idp + '.correct', f'Correct a memory ({scope})', 'action', 'Edits one memory in place (POST /api/memory/action, correct: server/memory/settings.ts:610).', 'today; the list is new')
    core._reg(idp + '.forget', f'Forget a memory ({scope})', 'action', 'Forgets the whole memory, every version, after an inline confirmation. The request names the version the row showed as expectedHead and sends no revision; the server checks the head inside the deletion transaction and refuses a stale one with nothing changed (TASKS M0; today the route takes an optional revision and deletes only that version, or everything with no check: server/memory/settings.ts:620-625, server/memory/forget.ts:31-60). A carry-over note keeps its own version-fenced route (forget-pip, settings.ts:626-633).', 'today, with the new guard; the list is new')
    botf = '' if who == 'Dax' else pick('All bots', 'Show memories from') + '<span class="hint">214 memories</span>'
    return (f'<div class="tbar">{inp(ph="Search memories", label="Search memories")}{botf}{seg(["All", "Facts", "How you like things", "Waiting for your yes"], "All", "Show")}</div>' +
            f'<div id="{idp}.items" data-id="{idp}.items">' + scroll(rows, 300, 'Memories') + '</div>' + count(f'{n} memories. Newest first.') +
            '<div class="cost"><b>Correct</b> changes the words. <b>Archive</b> hides a memory and can be undone. <b>Forget</b> deletes it and every earlier version of it for good, after you confirm. '
            'On a memory that is waiting for your yes, saving your words also approves it. If a memory changed since this list was read, Murage says "This memory changed. Read it again." and changes nothing. Chats are not changed.</div>')
def bmemory_sheet():
    core._reg('bot.memory.list.items', 'Memories for Dax')
    return sheet('What Dax remembers', 'Its own memories, ones from its chats, its team\'s, and ones shared with it. You can read, correct, archive or forget each one.', memlist('Dax', MEMS, D['memories'], 'bot.memory.list'), 'memory', 'mem')

def routines_body(restored=False):
    if restored:   # v8 (Astra r7 H5): the arrival of the restored-routine Fix draws the routine Off, with the restore named
        return S('Routines', R('Morning inbox sort', 'Every weekday at 07:00. Off since the restore on 18 Nov. It does not run again until you turn it on here.', icon='clock', id='bot.routines.morning', on=False, open=True, cls='why hl'),
                 R('Friday summary', 'Fridays at 16:00. Off since the restore on 18 Nov.', icon='clock', id='bot.routines.friday', on=False, open=True, cls='why'),
                 scope='Only Dax', id='bot.routines.list', sub='A restore turns every routine off. Each has its own switch')
    return S('Routines', R('Morning inbox sort', 'Every weekday at 07:00. Last run: today 07:00, done.', icon='clock', id='bot.routines.morning', on=True, open=True),
             R('Friday summary', 'Fridays at 16:00. Last run: 14 Nov, failed: Notion needs sign-in.', icon='clock', id='bot.routines.friday', on=True, open=True, cls='why',
               end=lnk('Fix: Sign in to Notion again', 'apps.html#apps.connected.notion') + lnk('See Activity', 'bot-activity.html')),
             f'<div class="paste">{A("New routine", "bot.routines.new", "pri", "Opens the Routines door in the main window.")}<span class="hint">Each new routine needs your yes.</span></div>',
             scope='Only Dax', id='bot.routines.list', sub='Each row says how its last run went')

def teams_body():
    return (S('Teams', R('Front office', 'With Chief and Juno.', icon='team', id='bot.teams.frontoffice', open=True), scope='Only Dax', sub='Groups of bots that work together. A team is not a way to add a person.')
            + S('Playbooks', R('2 playbooks', 'Step lists a team follows. Kept in the Team library.', icon='doc', go=('Open the Team library', '#'))))

def voice_body():
    return (S('Voice', R('Voice', f'{D["voice"]}. Assigned by Murage; choose another to make it your pick.', icon='voice', id='bot.voice.voice', val=D['voice']),
              R('Voice service', f'{D["voice_service"]}, the app default. Dax has no service of its own. The key for a service is saved once, in Providers.', icon='key', ref='tools.voice', go=('Tools', 'tools.html#tools.voice')),
              R('Read replies aloud', '', icon='voice', id='bot.voice.readaloud', on=False, tg=[('Only here',)]), scope='Only Dax', id='bot.voice.voicesec')
            + S('Notifications', R('Notifications about Dax', '', icon='bell', id='bot.voice.notifications', val='Same as General'),
                R('Notifications for every bot', '', icon='bell', ref='general.notifications', go=('General', 'general.html#general.notifications')), scope='Only Dax')
            + S('Calls', R('May call you when it is urgent', '', icon='call', id='bot.voice.calls', on=True),
                R('Calls today and quiet hours', 'Calls today: on.', icon='bell', ref='phone.calls', go=('Phone & remote access', 'phone.html#phone.calls')), scope='Only Dax'))

def activity_body():
    return (S('History', R('Today 08:41', 'Sorted 23 emails. Drafted 4 replies.', icon='history', open=True), R('Today 07:00', 'Morning inbox sort. Done.', icon='history', open=True),
              post='<div class="card gap"><div class="tfoot">148 entries. The newest 2 are above.<button type="button" class="lnk">Load older entries</button></div></div>', scope='Only Dax')
            + S('Usage this month', R('FluxRouter credit', '', icon='usage', st=('t', D['spend'])), R('Spend for every bot', '', icon='usage', go=('Usage & spend', 'usage.html')), scope='Only Dax'))

def teams_flow():
    team, mem = F.SK['team']
    lost = [(b, [a for a, v in F.APPS.items() if b in v['saved']]) for b in mem]
    li = ''.join(f'<li><b>{b}</b>: {", ".join(a)}.</li>' if a else f'<li><b>{b}</b>: nothing saved, nothing lost.</li>' for b, a in lost)
    note = ('v10 (Fable v9 H1, Astra r9 H4b): both buttons send the access revision of every member this dialog lists, even if there are no apps to list. '
            'deleteTeam compares them at admission, next to checkRevision (server/team-sections.ts:267) and before the journal row, request cancels, work interrupts and memory move (server/team-lifecycle.ts:59-63, :75) '
            'on the journal path and the legacy path alike. A different member set or revision answers 409 and nothing changes (TASKS SV0, F2).')
    return ('<div class="flow">' +
        dlg('Delete a team', f'Delete {team}?', '<p>Chief stops leading the team. Its bots keep their chats, memory, skills and files.</p>'
            f'<p><b>Both choices clear these saved app choices:</b></p><ul class="who">{li}</ul>'
            '<p>Bots with saved choices switch to Only chosen apps with no apps. Bots you archive are also hidden from the sidebar and their routines stop.</p>',
            B('Cancel') + A('Delete team and keep bots', 'bot.teams.deletekeep', 'red', note, 'new', slabel='Delete a team and keep its bots') + A('Delete team and archive bots', 'bot.teams.deletearchive', 'red', note, 'new', slabel='Delete a team and archive its bots')) +
        dlg('If a bot\'s apps changed while this was open', 'Juno\'s apps changed', '<p>Someone changed Juno\'s app choices in another window. Now: Google Calendar and Slack. Nothing was deleted, nothing was archived, and no work was stopped.</p>', B('Cancel') + B('Look again', 'pri')) + '</div>')

def archive_flow():
    """v8 (Astra r7 H4): every producer of hidden:true goes through one confirmation and one server comparison: this page's Archive and the sidebar menu's Archive."""
    apps = 'Gmail, Calendar and Notion'
    return ('<div class="flow">' +
        dlg('From this page or from the sidebar menu', 'Archive Dax?', f'<p>Dax is hidden from the sidebar and its routines stop. Its chats, memory, skills and files are kept, and you can bring it back from Bots.</p><p><b>Its saved app choices are not kept:</b> {apps}. Dax comes back set to Only chosen apps with no apps.</p>',
            B('Cancel') + B('Archive Dax', 'pri')) +
        dlg('If the app choices changed while this was open', 'Dax\'s apps changed', f'<p>Someone changed Dax\'s app choices in another window. Now: {apps} and Slack. Nothing was archived.</p>', B('Cancel') + B('Archive Dax', 'pri')) +
        dlg('A bot with nothing saved', 'Archive Kit?', '<p>Kit has no saved app choices, so nothing is lost. The sidebar archives it in one click and shows Restore, as today.</p>', B('Close')) + '</div>')

def build():
    G = 'Bot pages'
    bk = ('Bots', 'bots.html')
    def P(f, cur, title, sub, body, note='', **kw):
        page(f, G, 'bot', cur, title, sub, body, note=note, back=bk, **kw)
    P('bot-reach.html', 'reach', 'What it can reach', 'Everything Dax can do, what it asks about, and what is in the way. A chat with a guest in it always runs at Ask.', reach_body, learn=('How access works', 'reach'),
      aside=lambda: helpc('Why can\'t it?', 'Each blocked line names the <b>first</b> thing in the way. Fix opens that exact control, already in view.', 'The same link is on the error card in chat.'),
      note='First in the bot rail (Decision 1). Rows come from the fixture, so this page, Profile, Tools and the app sheets cannot disagree. Counts are capabilities, never "of 21". Every Fix lands on the leaf control: the write switch has its own id (Astra r4 4).')
    P('bot-profile.html', 'profile', 'Profile', 'Who Dax is and where it sits in the sidebar.', profile_body, learn=('How bots work', 'bots'), extra=archive_flow,
      aside=lambda: helpc('Saving', 'Name and Title save when you leave the field. Longer text has its own Save.', 'A change that would clear app choices asks first.'),
      note='Replies in is new (per-bot language, TASKS G7). Show in the sidebar is the positive form of the old Hide switch (switch audit).')
    P('bot-instructions.html', 'instructions', 'Instructions', 'What Dax is told to do, and what else shapes it.', instructions_body, learn=('Writing instructions', 'instructions'))
    P('bot-model.html', 'model', 'Engine & model', 'What runs Dax and which model it uses.', model_body, learn=('How models work', 'models'),
      aside=lambda: steps(3), note='Engine is a chooser: one PATCH is sent only when a complete engine and model pair is picked (Astra r4 6). Saved waits for the server. When the plan runs out has its id drawn inside the Advanced line (Fable 12).')
    P('bot-tools.html', 'btools', 'Tools', TOOLS_SUB + ' Tools: what Dax can use. Approvals: when Dax must ask first.', bot_tools_body, learn=('How tools work', 'tools'),
      pm=pmap(('Built in', 'bot.tools.builtin'), ('Uses something of yours', 'bot.tools.yours')),
      aside=lambda: helpc('Something not working?', 'What it can reach lists the first thing in the way for each tool.', link=('How tools work', 'tools')),
      note='21 rows, catalog order. The count is computed from the fixture. The waiting request is a signpost to its review: Approve lives only where the consequence is shown (Astra r4 1).')
    P('bot-tools-apps.html', 'btools', 'Tools', TOOLS_SUB, bot_tools_body, sh=bot_apps_sheet, crumbs=[('Tools', 'bot-tools.html')], last='Gmail and other apps', rebody=True,
      note='Per-app access for one bot. Each row is one set-account save. No whole-form Save, so a save never clears a waiting request (Fable 1). The write switch, the mode and each app have their own ids, so Fix links land on the leaf.')
    PAGES['bot-tools-apps.html'] = ('Bot Tools: Gmail and other apps sheet', 'Sheets and flows', 'Saved against works now, request review')
    P('bot-approvals.html', 'approvals', 'Approvals', 'When Dax must ask you first.', approvals_body, learn=('How approvals work', 'approvals'),
      aside=lambda: helpc('Changing your mind', 'After a change the line reads Saved, with Change back. Change back is never offered for No limits.', 'Each level is described the same way on every page.'),
      note='Each level has its own line, and under them the shipped table of what each level asks about (shared/level-examples.ts:46-58; src/locales/en-ux/l1.json:109-125), open in Simple: the four sentences alone made Full access read stricter than Auto (Walk r6 H1). The bot level is the default for new chats (l1.json:104).')
    P('bot-skills.html', 'bskills', 'Skills', f'Know-how Dax follows. {D["skills_on"]} on.', bskills_body, learn=('How skills work', 'skills'),
      aside=lambda: helpc('On is not the same as used', 'Each message carries a short list of the skills that are on, up to a fixed size. A skill past that size is looked up only when a task needs it.', 'A team is not a skill owner. To turn a skill on for a whole team, open the skill and use Turn on for all.', link=('How skills work', 'skills')),
      note='v7, from the skills study. Two skills on, both in every message. Add a skill searches the whole library. The built-ins Murage adds by keyword have no switch, because the code has none (server/skill-library.ts:160-172); the Chief-only built-in is not drawn on Dax (server/skills-api.ts:147).')
    P('bot-memory.html', 'bmemory', 'Memory & learning', 'What Dax remembers.', bmemory_body, learn=('How memory works', 'memory'),
      note='What Dax remembers is new: a list of single memories (independent C3). Start fresh is a visible row in Simple (Astra r4 9).')
    P('bot-memory-list.html', 'bmemory', 'Memory & learning', 'What Dax remembers.', lambda: bmemory_body(True), sh=bmemory_sheet, crumbs=[('Memory & learning', 'bot-memory.html')], last='What Dax remembers', rebody=True,
      note='View, correct and forget one memory. Built on the shipped memory action route: list, correct and forget (server/memory/settings.ts:113, :610, :620). One row is drawn mid-confirmation.')
    PAGES['bot-memory-list.html'] = ('Bot Memory: What Dax remembers', 'Sheets and flows', 'List, correct, forget one memory')
    P('bot-routines.html', 'routines', 'Routines', 'What Dax does on a schedule.', routines_body, learn=('How routines work', 'routines'),
      note='Every row says how its last run went, in words, with a link (independent H7). The paused state is drawn in states.html.')
    P('bot-teams.html', 'teams', 'Teams', 'The teams Dax works in.', teams_body, learn=('How teams work', 'teams'), extra=teams_flow)
    P('bot-voice.html', 'voice', 'Voice & notifications', 'How Dax sounds, and when it may reach you.', voice_body, learn=('Voice and calls', 'voice'),
      note='Voice service shows the effective service for this bot and says it is the app default (Astra r4 16; server/tts/reply-provider.ts:28-39).')
    P('bot-activity.html', 'activity', 'Activity', 'What Dax did and what it cost.', activity_body, learn=('Reading activity', 'activity'))
    # An archived bot: its pages open and work (Walk r6 L8)
    P('bot-routines-restored.html', 'routines', 'Routines', 'What Dax does on a schedule.', lambda: routines_body(True), rebody=True, learn=('How routines work', 'routines'),
      note='v9 (Astra r8 H5): drawn for Dax, before the archived-bot pages switch the rail to Old Dax. v8 (Astra r7 H5): where the Fix on states.html window 5 lands. After a restore every routine is off (server/installation-activation.ts:71-75), so the arrival draws Morning inbox sort Off, with the restore named and the switch in view. L1 and Q1 compare the routine id and its switch state at the destination.')
    PAGES['bot-routines-restored.html'] = ('Bot Routines after a restore', 'Sheets and flows', 'Arrival of the restored-routine Fix: the routine is Off')
    core.BOTCTX.update(n='Old Dax', role='Archived. Inbox assistant', av='O', needs={})
    P('bot-memory-archived.html', 'bmemory', 'Memory & learning', 'What Old Dax remembers.', lambda: bmemory_body().replace('Dax', 'Old Dax').replace('Old Old Dax', 'Old Dax'), rebody=True, learn=('How memory works', 'memory'),
      banner=lambda: ban('<b>Old Dax is archived.</b> It is hidden from the sidebar and its routines are stopped. Everything on this page still works. Bring it back from Bots.', 'off', lnk('Open Bots', 'bots.html#bots.table')),
      note='An archived bot opened from the Overview finder. Start fresh works on it. Both fast doors use the roster that includes archived bots (src/lib/settings-shell-bots.ts:18-21).')
    PAGES['bot-memory-archived.html'] = ('Memory & learning for an archived bot (Old Dax)', 'Sheets and flows', 'Archived note, Start fresh still works')
    core.BOTCTX.update(n='Chief', role='Chief of staff', av='C', needs={})
    P('bot-skills-chief.html', 'bskills', 'Skills', f'Know-how Chief follows. {F.SK["chief_on"]} on.', PS.chief_skills_body, banner=PS.chief_banner, state=True, learn=('How skills work', 'skills'),
      note='A bot over the list size. Each message carries an index of the bot\'s own enabled skills, capped at 30 lines and 4,000 bytes (server/skills.ts:137-138); the leading lines that fit are kept (:1996-2003). About 6 library skills fit. The page says which 6. Chief of staff basics has a real switch only here (server/index.ts:33882-33884). A changed engine copy and a learned skill wait for the owner and have no switch.')
    PAGES['bot-skills-chief.html'] = ('Skills for a bot over the list size (Chief)', 'Sheets and flows', 'In every message against looked up; two waiting')
    # Pepper, the one bot at No limits
    core.BOTCTX.update(n='Pepper', role='Research', av='P', needs={})
    P('bot-reach-nolimits.html', 'reach', 'What it can reach', 'What Pepper can do at No limits, and on which turns.', reach_nolimits_body, banner=nolimits_banner, rebody=True, learn=('How access works', 'reach'),
      note='The No limits banner is drawn on Pepper, never on Dax. It claims only what the code proves still holds: Connected apps off for the bot (server/bot-access.ts:208, before the No limits return at :209), the wipe check (server/auto-approve.ts:1000-1025) and question tools (:1123). Which turns count comes from noLimitsAppliesTo (server/no-limits-origin.ts:19-29): owner messages, owner channel messages, routines, trigger links and handed-over work in an owner-only chat; never a guest chat, a draft-only bot or an unproven turn. The level of the chat itself wins over the level of the bot (server/store.ts:6113), and a guest chat has no connected apps at all (server/store.ts:6114; server/connector-requests.ts:228-239). Shipped test: server/decision/no-limits-live-owner-1019.test.ts:43-52. The banner is a standing notice, so it is not amber and is not counted under Needs you (Visual QA M08).')
    PAGES['bot-reach-nolimits.html'] = ('What it can reach, for a bot at No limits (Pepper)', 'Sheets and flows', 'Which turns count, and what still holds')
    core.BOTCTX.update(n='Dax', role='Inbox assistant', av='D', needs={'btools': 'Needs you'})
