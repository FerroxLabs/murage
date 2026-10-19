"use server";
import { redirect } from "next/navigation";
import { cpRaw } from "@/lib/cp";
import { clearToken, getToken } from "@/lib/session";

export async function signOut() {
  const token = await getToken();
  if (token) await cpRaw("/api/auth/sign-out", { token, body: {} }).catch(() => undefined);
  await clearToken();
  redirect("/sign-in");
}
