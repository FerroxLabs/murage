// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a (designs/1021-m2-w0 r5, Fable N1): the ONE named way a test turns the hosted Fuigo
// override on in a real server child: `node --import ./server/testing/hosted-override-preload.mjs server/index.ts`.
// Owner: O1 m2 S1a builder lane (fix/1022-o1m2), both sides (this preload and hosted-mode.ts's arm).
//
// It refuses outside the repo's two test runners, and no shipped module imports it, so the
// packaged bundle (built from server/index.ts) never contains it. T-S1A-NO-SWITCH pins both.
if (!process.env.VITEST && !process.env.NODE_TEST_CONTEXT) throw new Error("HOSTED_UNQUALIFIED_BUILD");
const { armHostedOverrideForTest } = await import("../host/hosted-mode.ts");
armHostedOverrideForTest({ hostedQualifiedOverride: true });
