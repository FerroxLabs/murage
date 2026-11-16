// SPDX-License-Identifier: AGPL-3.0-or-later
// OWNER checker: wipe-v3. OWNER fault consumer: wipe-v3-tests.
import {afterEach,it,vi} from 'vitest';
import {hungFilesystemScenario,mountQueryFailureScenario,freshMountScenario,registryFaultScenario,walkerFaultScenario,tolerantFaultScenario,contextFaultScenario,executionDriveScenario} from './v3-fault-scenarios.fixture.ts';
afterEach(()=>vi.restoreAllMocks());
it('V3-FAULT-1 hung keys retain healthy protection and respect quarantine ceiling',hungFilesystemScenario,15000);
it('V3-FAULT-2 mount query throw and timeout preserve independent realpath',mountQueryFailureScenario);
it('V3-FAULT-3 fresh mount confirmation distinguishes data mount, firmlink and timeout',freshMountScenario);
it('V3-FAULT-4 registry isolates owners and never retries failed boot per query',registryFaultScenario);
it('V3-FAULT-5 statement recovery preserves later effects and bounds nesting',walkerFaultScenario);
it('V3-FAULT-6 tolerant seeded fuzz, linear megabyte scan and evidence-only double fault',tolerantFaultScenario,30000);
it('V3-FAULT-7 throwing context reader remains inside autoVerdict containment',contextFaultScenario);
it('V3-FAULT-8 execution drive and UNC share roots',executionDriveScenario);
