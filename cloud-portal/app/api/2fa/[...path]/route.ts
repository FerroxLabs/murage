import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { cp, CPError } from "@/lib/cp";
import { getToken } from "@/lib/session";

// Browser calls to the control plane's second-factor routes. The session token stays in the
// HttpOnly cookie; the browser never sees it.
const ALLOWED = new Set(["register/options", "register", "assert/options", "assert"]);

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  if (request.headers.get("origin") !== config.portalOrigin) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  const path = (await ctx.params).path.join("/");
  if (!ALLOWED.has(path)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const token = await getToken();
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await request.json().catch(() => ({}));
    const data = await cp<Record<string, unknown>>(`/v1/account/2fa/${path}`, { token, body });
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof CPError) return NextResponse.json({ error: e.code }, { status: e.status });
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
