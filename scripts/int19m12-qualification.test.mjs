// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { COMPARISON_BASE, INTEGRATION_START, assertComparisonBase, compareIds, assertIntegrationRedCoverage } from './int19m12-qualification.mjs';
it('M2 requires the unambiguous gate base instead of the integration parent',()=>{
 expect(()=>assertComparisonBase('ca5978bf07aabdae66cc132969d26073f31f372b')).toThrow('comparison-base-mismatch');
 expect(()=>assertComparisonBase('f6b9')).toThrow('comparison-base-mismatch');
 expect(()=>assertComparisonBase('f6b9b86de72d64bd10f1d0363b7d44f58ae3af32')).not.toThrow();
 expect(COMPARISON_BASE).toBe('f6b9b86de72d64bd10f1d0363b7d44f58ae3af32');
});
it('M2 retains a new failing ID inside an already-red file',()=>{
 expect(compareIds({'same.test.ts :: old':'failed','same.test.ts :: new':'passed'},{'same.test.ts :: old':'failed','same.test.ts :: new':'failed'})).toEqual(['same.test.ts :: new']);
});
it('M3 requires assertion RED at exact integration start and a killed mutant for every behavior',()=>{
 const valid={behavior:'native-card',source:INTEGRATION_START,red:'assertion-failed',green:'passed',mutant:'assertion-failed'};
 expect(()=>assertIntegrationRedCoverage(['native-card'],[valid])).not.toThrow();
 for(const change of [{source:'68ee615aba094f9209bbc482a1a21cd62d024367'},{red:'load-failed'},{green:'skipped'},{mutant:'passed'}]) expect(()=>assertIntegrationRedCoverage(['native-card'],[{...valid,...change}])).toThrow('integration-start-red-unproved');
 expect(()=>assertIntegrationRedCoverage(['native-card','queue'],[valid])).toThrow('queue');
});
