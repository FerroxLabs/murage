export const ONBOARDING_CHOICES = [
  { id: "starter-personal-home", title: "Organize my day", detail: "Turn your notes and commitments into a short, practical plan." },
  { id: "starter-solo-business", title: "Run my business", detail: "Choose priorities and prepare the next piece of work." },
  { id: "starter-business-team", title: "Build and create", detail: "Shape a brief, create a first draft, and review it." },
] as const;
export type OnboardingChoice = typeof ONBOARDING_CHOICES[number]["id"];
export const ONBOARDING_PROGRESS_KEY = "murage-onboarding-v2";
export interface OnboardingProgress { choice: OnboardingChoice | null; instanceId: string; model: string }
export function readOnboardingProgress(storage: Pick<Storage, "getItem">): OnboardingProgress {
  const empty: OnboardingProgress = { choice: null, instanceId: "", model: "" };
  try {
    const value = JSON.parse(storage.getItem(ONBOARDING_PROGRESS_KEY) ?? "null");
    if (!value || !ONBOARDING_CHOICES.some(choice => choice.id === value.choice)) return empty;
    return { choice: value.choice, instanceId: typeof value.instanceId === "string" ? value.instanceId : "", model: typeof value.model === "string" ? value.model : "" };
  } catch { return empty; }
}
