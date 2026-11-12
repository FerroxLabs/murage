// SPDX-License-Identifier: AGPL-3.0-or-later
// Explicit test-only throw points. Production readers never consult this module.
export function throwingReader():never{throw new Error('fixture-reader-fault');}
// The r2 finalDecision/assertCard/logAsked sites now correspond to the BASE
// callback, final-row guard and isolated decision observer. No production mint.
export const faultSites=Object.freeze(['actor','deny','shell','python','base','guard','row','answer','observer'] as const);
