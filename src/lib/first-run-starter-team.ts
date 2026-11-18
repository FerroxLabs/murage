// The default starter team, as the first run offers it (FIRSTRUN-1019 slice D hires from these packages). The welcome draws their real
// faces. This is a copy of what library/packages/starter-*.json say about each agent's name and look; first-run-starter-team.test.ts
// reads those files and fails if the two ever differ.
export interface StarterFace { key: string; name: string; color: string; mascotBody: string }

export const STARTER_TEAM: readonly StarterFace[] = [
  { key: "business-planner", name: "Business Planner", color: "blue", mascotBody: "squircle" },
  { key: "draft-partner", name: "Draft Partner", color: "orange", mascotBody: "drop" },
  { key: "team-coordinator", name: "Team Coordinator", color: "purple", mascotBody: "ember" },
  { key: "delivery-partner", name: "Delivery Partner", color: "green", mascotBody: "squircle" },
  { key: "review-partner", name: "Review Partner", color: "blue", mascotBody: "shield" },
  { key: "home-planner", name: "Home Planner", color: "yellow", mascotBody: "squircle" },
];
