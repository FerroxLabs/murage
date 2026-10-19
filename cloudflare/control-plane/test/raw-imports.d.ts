// SPDX-License-Identifier: AGPL-3.0-or-later
// Vite's `?raw` suffix returns the file's text.
declare module "*?raw" {
  const text: string;
  export default text;
}
