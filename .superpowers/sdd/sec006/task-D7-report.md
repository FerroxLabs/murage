# D7 report

Both doors now forward the answering device's id, class and key on the two respond routes, built from the registry (`approvalIdentity`) and never from client headers. They send them only when the door holds a usable 64-hex launch credential (`hasLaunchCredential`). The class is whatever the registry holds; a TODO names D15 for the relay-verified "app" class.

Files: companion/src/routes.ts, browser.ts, proxy.ts; tests in companion/test/routes.test.ts and a new companion/test/approval-door-headers.test.ts (self-contained stub harnesses for both doors, since browser.test.ts and proxy.test.ts have no stub with a launch token); server/browser-extension-phone.test.ts regex tightened to /^approve_on_computer$/ (run owed on Hetzner).

Red first: routes.test.ts 3 failed (approvalDeviceHeaders undefined), approval-door-headers.test.ts 2 failed (forward-values tests; the no-credential tests passed trivially).
Green: vitest run companion: 884 pass, 1 fail (server/companion-authority.test.ts real-harness boot times out at 30s on this Mac; not touched by D7; owed on Hetzner). tsc -b and tsc -p tsconfig.server.json clean.
