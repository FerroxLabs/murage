// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FTS5 hands back equal-rank rows in the order they were written. That order is not a property of the records: two indexes
// holding the same readable records, one with a few more rows around them, order equal ranks differently (msearch review
// round 4). Asking SQLite for `ORDER BY rank, id, version` would settle it, but adding keys after `rank` ends FTS5's own
// ordered cursor and sorts every match before the limit applies (measured on the 60k fixture: a page cost 60 ms instead of
// 13 ms). So the query keeps `ORDER BY rank` and this settles ties after it, on a window of the ranked rows: the rows of a
// page, plus every row of the runs of equal ranks that the page starts and ends in, however long those runs are (round 5:
// a cap on the widening repeated whole pages once a run was longer than the cap). The page is then positions
// [offset, offset + limit) of the order (rank, id, version): exactly `limit` rows, and the same rows whichever way the index
// happened to hold the ties. The cost of a page grows with the length of the runs it touches, and only with those.
type Ranked = Record<string, unknown>;
/** Rows read on either side of a page in the first read, in case a run of equal ranks continues past its edges. Most runs of
 * equal ranks are far shorter, and every further read costs a full ranking of the matches, so this is generous on purpose. */
export const TIE_FIRST_READ_ROWS = 256;
/** A run that crosses an edge of the window widens that side of the window by this factor and reads again. */
const TIE_WIDEN = 4;

export const before = (a: Ranked, b: Ranked) => (Number(a.rank) - Number(b.rank)) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : Number(a.version) - Number(b.version));

/** `fetch(start, count)` returns `count` rows from position `start` of the ranked rows (fewer at the end). Returns the page and
 * whether rows follow it. Reads the page with TIE_FIRST_READ_ROWS around it and, while a run of equal ranks still crosses an
 * edge of the window, reads again with that side widened (a read per factor of TIE_WIDEN of the run's length). */
/** How many pages needed a wider read (a run of equal ranks crossing the first read's edge). For tests and measurements. */
export const tieStats = { pages: 0, widened: 0 };
export function pageByRank<T extends Ranked>(fetch: (start: number, count: number) => T[], offset: number, limit: number): { rows: T[]; more: boolean } {
  let back = Math.min(offset, TIE_FIRST_READ_ROWS), forward = TIE_FIRST_READ_ROWS;
  for (let attempt = 0; ; attempt++) {
    const lo = offset - back;
    const rows = fetch(lo, back + limit + forward);
    const first = rows[back], last = rows[Math.min(rows.length, back + limit) - 1];
    if (!first) return { rows: [], more: false };
    // the run the page starts in begins inside the window, and the run it ends in ends inside it (or the rows ran out)
    const frontDone = lo === 0 || rows[0].rank !== first.rank;
    const backDone = rows.length < back + limit + forward || rows[rows.length - 1].rank !== last.rank;
    if (attempt === 0) tieStats.pages++;
    if (!(frontDone && backDone)) {
      if (attempt === 0) tieStats.widened++;
      if (!frontDone) back = Math.min(offset, back * TIE_WIDEN);
      if (!backDone) forward *= TIE_WIDEN;
      continue;
    }
    // order each run of equal ranks by (id, version); runs are contiguous, so this is a sort of the window
    const ordered = rows.slice().sort(before);
    return { rows: ordered.slice(back, back + limit), more: rows.length > back + limit };
  }
}
