// SPDX-License-Identifier: AGPL-3.0-or-later
export declare function perfBudgetDecision(env: NodeJS.ProcessEnv, load1: number): {
  mode: "enforced" | "skipped" | "refused";
  message: string;
};
export declare function guardPerfBudget(name: string, skip: (message: string) => void, env: NodeJS.ProcessEnv, load1: number, log?: (message: string) => void): void;
export declare function assertPerfReport(report: unknown): number;
