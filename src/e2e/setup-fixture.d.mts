// Types for setup-fixture.mjs. It stays JavaScript because setup-prepare.mjs
// runs it under a bare `node`, the same reason server/testing/safe-wipe.mjs
// carries its declarations beside it rather than being a .ts module.
export declare const FIXTURE_CLI: string;
export declare const FIXTURE_INSTANCE: string;
export declare function setupFixtureConfig(): {
  instances: Record<string, { driver: string; displayName: string; config: { cli: string; fullAuto: boolean } }>;
};
