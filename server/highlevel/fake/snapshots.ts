// S0 frozen fake-provider extension point. No live account or credentials.
import type { FakeHighLevelRoute } from "../fake-provider.ts";
export const snapshotsRoutes: readonly FakeHighLevelRoute[] = [];
export default snapshotsRoutes;
