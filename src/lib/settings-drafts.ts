// SPDX-License-Identifier: AGPL-3.0-or-later
/** Unsaved words in the app settings editors (house rules, About me), kept for the life of the window rather than of the editor.
 *  The settings window unmounts an editor whenever its page changes or a search replaces the page, and the person's typing used to go with
 *  it. An entry exists only while its words differ from the saved ones; `recall` hands them back only if the saved text is still the text
 *  they were written against, so a rule changed elsewhere in the meantime is never overwritten by an old draft. */
export function createSettingsDraftStore() {
  const entries = new Map<string, { draft: string; saved: string }>();
  return {
    /** Keep `draft` for `key`, or forget the key when there is nothing unsaved. */
    remember(key: string, draft: string, saved: string): void {
      if (draft === saved) entries.delete(key);
      else entries.set(key, { draft, saved });
    },
    /** The unsaved words for `key`, when they were written against exactly this saved text. */
    recall(key: string, saved: string): string | null {
      const entry = entries.get(key);
      return entry && entry.saved === saved ? entry.draft : null;
    },
    forget(key: string): void { entries.delete(key); },
    anyUnsaved(): boolean { return entries.size > 0; },
    clear(): void { entries.clear(); },
  };
}

export const settingsDrafts = createSettingsDraftStore();

/** The question asked before settings close with unsaved words. */
export const DISCARD_SETTINGS_CHANGES = "Discard unsaved changes and close settings?";
