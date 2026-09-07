const prompts: Record<string, string> = {
  "starter-personal-home": "Help me organize the household tasks and personal commitments in my notes. Prioritize up to three next actions, identify missing dates or constraints, and do not assume access to my calendar or accounts.\n\nMy notes:\n",
  "starter-solo-business": "Help me turn my business notes into a practical work plan. Identify priorities, next actions and questions about missing information. Use only the information I provide; do not assume access to customer accounts or send anything.\n\nMy notes:\n",
  "starter-business-team": "Help our team turn these notes into a practical operations plan. Suggest owners and next actions, flag uncertainty, and ask before assigning consequential work or contacting anyone. Do not assume access to connected accounts.\n\nMy notes:\n",
};

/** A draft suggestion, never a send action. Preserve even a whitespace-only
 * user draft or attachment-only message instead of deciding it is disposable. */
export function starterFirstTaskDraft(profileId: string, existingText: string, attachmentCount: number): string | null {
  if (!Object.hasOwn(prompts, profileId) || existingText.length > 0 || attachmentCount !== 0) return null;
  return prompts[profileId];
}
