import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { config } from "./config";

export async function getToken(): Promise<string | null> {
  return (await cookies()).get(config.cookieName)?.value ?? null;
}
export async function setToken(token: string) {
  (await cookies()).set(config.cookieName, token, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7,
  });
}
export async function clearToken() {
  (await cookies()).set(config.cookieName, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
}
/** Same-site paths only. Anything else becomes the fallback. */
export function safeNext(value: unknown, fallback = "/cloud"): string {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : fallback;
}
export async function requireToken(next: string): Promise<string> {
  const token = await getToken();
  if (!token) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return token;
}
