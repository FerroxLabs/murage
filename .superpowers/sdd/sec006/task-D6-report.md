# D6 report
Files: companion/src/browser.ts, companion/test/browser-code.test.ts, companion/test/browser-mobile.test.ts.
Failed first: browser-code "reads &approvalKey=...", "the redeem route hands the install id and key to the registry"; browser-mobile healthz probe (edited to expect approvalProof: 1).
After: browser-mobile, browser-code, browser.test 147 pass; all companion/test 700 pass; tsc -b and tsc -p tsconfig.server.json clean.
Done: /healthz adds approvalProof: 1 (mobile: 2 kept); fragment parse by indexOf; codeEntryScript(installIdVar, approvalKeyVar); sign-in body; redeem fifth argument.
Note: companion/src/index.ts proxy (native) redeem is not forwarded: that path carries no install id or key; out of D6 scope.
