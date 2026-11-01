// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shell's slots for other lanes' components (handoffs/HANDOFF-1013-UX-L2A.md,
// shell contract). App.tsx and Today import ONLY from here. When a lane merges,
// its line below changes to point at the lane's real module; the names and
// props are the contract's and do not change.
//
// Merge note for the integrator, one line per lane:
//   L2B  needs:  export { NeedsYouPage, useNeedsSummary } from "@/components/needs/NeedsYouPage";
//   L2B  health: export { HealthPage } from "@/components/health/HealthPage";
//                export { useHealthStatus } from "@/components/health/health-status";
//   L6A  export { FirstRunTodayCard } from "@/components/today/FirstRunTodayCard";
//   L2C  export { MonthCard, useMonthTag } from "@/components/today/MonthCard";
//   L6C  export { ClientsCard, useClientsTag } from "@/components/agency/ClientsCard";
//        export { OtherWorkspacesStrip } from "@/components/agency/OtherWorkspacesStrip";
//   L7   export { PhoneTabs } from "@/components/phone/PhoneTabs";
export { NeedsYouPage, useNeedsSummary } from "./stubs/needs-stub";
export { HealthPage, useHealthStatus } from "./stubs/health-stub";
export { FirstRunTodayCard } from "./stubs/cards-stub";
export { MonthCard, useMonthTag } from "./stubs/cards-stub";
export { ClientsCard, useClientsTag } from "./stubs/cards-stub";
export { OtherWorkspacesStrip } from "./stubs/cards-stub";
export { PhoneTabs } from "./stubs/cards-stub";
