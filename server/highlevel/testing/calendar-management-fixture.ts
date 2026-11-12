// SPDX-License-Identifier: AGPL-3.0-or-later
import { calendarWorkflowFixture as legacyFixture } from './calendar-fixture.ts';
import { calendarManagementOperationSpec, calendarManagementFamilyOperations } from '../calendar-management.ts';
import type { HighLevelHostDeps } from '../host.ts';
export { workflowArgs, calendarLocation, originalInterval } from './calendar-fixture.ts';
export function calendarWorkflowFixture(policy = true, overrides: Partial<HighLevelHostDeps> = {}) {
 return legacyFixture(policy, { operationSpec: calendarManagementOperationSpec, familyOperations: calendarManagementFamilyOperations, ...overrides });
}
