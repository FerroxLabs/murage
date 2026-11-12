// Explicit integration suite: requires the S1 production dependency snapshot.
export default {test:{environment:'node',include:['server/memory/field-policy.fixture.ts'],setupFiles:['server/testing/setup.ts'],fileParallelism:false,testTimeout:45000}};
