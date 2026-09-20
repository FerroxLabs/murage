// A name in the possessive, the way English writes it.
//
// Bot names are the owner's own words, and a bot called Numbers turned every
// "Open {name}'s profile" into "Open Numbers's profile". A singular name that
// already ends in s takes a bare apostrophe, so the one rule lives here
// instead of in each label that happens to need it.
//
// Straight apostrophe on purpose: it is the character the surrounding labels
// and their tests already use.

/** "Ember" → "Ember's"; "Numbers" → "Numbers'". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}
