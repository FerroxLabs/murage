const prompts: Record<string, string> = {
  "starter-personal-home": "Help me organize the household tasks and personal commitments in my notes. Prioritize up to three next actions, identify missing dates or constraints, and do not assume access to my calendar or accounts.\n\nMy notes:\n",
  "starter-solo-business": "Help me turn my business notes into a practical work plan. Identify priorities, next actions and questions about missing information. Use only the information I provide; do not assume access to customer accounts or send anything.\n\nMy notes:\n",
  "starter-business-team": "Help me turn these notes into a clear brief and a first draft I can review. Identify the deliverable, constraints and missing information, then suggest one practical next step. Do not assume access to connected accounts; ask before publishing or contacting anyone.\n\nMy notes:\n",
};

/** A draft suggestion, never a send action. Preserve even a whitespace-only
 * user draft or attachment-only message instead of deciding it is disposable. */
export function starterFirstTaskDraft(profileId: string, existingText: string, attachmentCount: number): string | null {
  if (!Object.hasOwn(prompts, profileId) || existingText.length > 0 || attachmentCount !== 0) return null;
  return prompts[profileId];
}
