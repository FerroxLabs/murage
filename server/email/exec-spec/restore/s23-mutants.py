#!/usr/bin/env python3
import sys
from mutation_runner import run_mutants
R, S, M = 'restore-reducer.ts', 'seeds.ts', 'moves.ts'
MUT = {
 'm1': (R, 'if (!t.startsWith("bot:")) { R.hit("tryAgain.not_bot");', 'if (false) { R.hit("tryAgain.not_bot");'),
 'm2': (R, 'if (targetOfBinding(b2) !== k.target && b2.botId !== k.botId) continue;', 'if (b2.botId !== k.botId) continue;'),
 'm3': (R, 'if (origin !== "restore" && keysOfBinding(b).some(k => L.keptKeys[k]))', 'if (false)'),
 'm4': (R, 'address: b.address, visible: true,', 'visible: true,'),
 'm5': (R, 'const staleUntokened = !needsToken', 'const staleUntokened = false && !needsToken'),
 'm6': (R, 'const premise = (a.section === "other_setup" || a.section === "key_only")', 'const premise = (a.section !== "bot")'),
 'm7': (R, 'if (needsToken && inboxId !== null && !parksOnT.length', 'if (needsToken || false && !parksOnT.length'),
 'm8': (R, '  if (heldLease) {', '  if (false) {'),
 'm9': (R, 'render(R, false, true); return R.s.surface; }', 'render(R, false, true); return []; }'),
 'm10': (S, 'keyIds: gen?.emailKeyRef ? [gen.emailKeyRef] : [] }, issuedTo', 'keyIds: [] }, issuedTo'),
 'm11': (M, 'for (const tg of [botTarget(b), ...d.inboxes.map(inboxTarget)])', 'for (const tg of [botTarget(b)])'),
 'm12': (R, '    if (vals(L.keepOps).some(k => k.target === targetOfBinding(b))) continue;', '    if (false) continue;'),
 'm13': (R, '(ti.kind === "p" && !parkOfTok)', '(ti.kind === "p")'),
 'm14': (M, 'm.env.ghost.authorities.length = authLen0;', 'void 0;'),
 'm15': (M, 'm.env.ghost.lastParkOrRestoreStep[p.botId] = m.env.step;', 'void 0;'),
 'm16': (R, 'const stamp = R.x.parkTok?.[botId]; if (stamp !== undefined', 'const stamp = R.x.parkTok?.[botId]; if (false && stamp !== undefined'),
 'm17': (S, 'answer: "refused", code: "409_not_closing"', 'answer: "ok", code: "409_not_closing"'),
}
if __name__ == '__main__':
    run_mutants(MUT, ['s23.test.ts', 'view-scope.test.ts'], sys.argv[1:] or list(MUT))
