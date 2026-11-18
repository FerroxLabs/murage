// SPDX-License-Identifier: AGPL-3.0-or-later
// Explicit, skip-free design-red entrypoint. *.red.ts is outside the normal *.test.ts gate discovery.
import base from '../../vite.config.ts';
export default { ...base, test: { ...base.test, include: ['server/routines-history-bound.red.ts'], env: { RHIST_COUNT_ONLY: "1" }, hookTimeout: 300000, testTimeout: 180000 } };
