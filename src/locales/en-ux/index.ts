// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// English fragments for the 1.0.12 to 1.0.14 UX lanes. src/locales/en.json has
// one owner (the copy lane); every other lane writes its NEW English keys into
// its own file here, `<lane>.json`, every key starting `ux.<lane>.`. The pack in
// ../index.ts merges these under en.json, so `t()` and `LocaleKey` see them like
// any other key. A lane never edits another lane's file, en.json or this list.
//
// Every lane's file already exists (as `{}`), so a lane edits one file and
// nothing else: no import line to add, nothing to merge in index.ts.
// locale-copy.test.ts holds the rules: the prefix, no key that en.json or
// another fragment already has, the house copy rules.
//
// Thu 5 Nov (1.0.14 last merge): the copy lane folds every fragment into
// en.json and deletes this folder, so the frozen build has one catalogue.
import l1 from "./l1.json";
import l2a from "./l2a.json";
import l2b from "./l2b.json";
import l2c from "./l2c.json";
import l3a from "./l3a.json";
import l3b from "./l3b.json";
import l4a from "./l4a.json";
import l4b from "./l4b.json";
import l4c from "./l4c.json";
import l5a from "./l5a.json";
import l5b from "./l5b.json";
import l6a from "./l6a.json";
import l6b from "./l6b.json";
import l6c from "./l6c.json";
import l7 from "./l7.json";
import l8 from "./l8.json";
import lcopya from "./lcopya.json";
import lcopyb from "./lcopyb.json";
import lcopyc from "./lcopyc.json";
import lcopyd from "./lcopyd.json";
import lfb from "./lfb.json";
import lgate from "./lgate.json";

/** Each lane's fragment by lane id (the file name and the key prefix `ux.<lane>.`). */
export const enUxFragments = { l1, l2a, l2b, l2c, l3a, l3b, l4a, l4b, l4c, l5a, l5b, l6a, l6b, l6c, l7, l8, lcopya, lcopyb, lcopyc, lcopyd, lfb, lgate } as const;

type Fragments = typeof enUxFragments;
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;
/** Every fragment key, typed, so `LocaleKey` carries them. */
export type EnUx = UnionToIntersection<Fragments[keyof Fragments]>;

/** All fragments in one object. Lane files never share a key (each has its own prefix). */
export const enUx = Object.assign({}, ...Object.values(enUxFragments)) as EnUx;
