// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
// The additive-only ruling preserves the default contracts in these suites.
it.each(['operations/calendars.test.ts', 'calendars-management.test.ts', 'calendar-review-repairs.test.ts'])('%s retains default-contract coverage', file => {
 const source = readFileSync(new URL(file, import.meta.url), 'utf8');
 expect(source).not.toContain('calendar-management-fixture.ts');
 expect(source).not.toContain('calendar-management-crash-worker.ts');
 expect(source).not.toContain('calendarManagementOperationSpec');
 expect(source).not.toContain('calendarManagementFamilyOperations');
 expect(source).toContain(file.startsWith('operations/') ? "from './calendars.ts'" : "from './testing/calendar-fixture.ts'");
});
