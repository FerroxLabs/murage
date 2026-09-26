// Imported first by main.tsx, before any module that builds a schema.
//
// Zod 4 compiles object parsers with `new Function` when it can, and finds
// out whether it can by trying once. The browser door's CSP has no
// 'unsafe-eval', so that probe is refused and reported as a violation on
// every load (phone verification, I2). Jitless skips the probe and the
// compiler; the interpreted parser gives the same answers.
import { z } from "zod";

z.config({ jitless: true });
