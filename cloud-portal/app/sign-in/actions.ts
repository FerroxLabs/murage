"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { cpRaw } from "@/lib/cp";
import { safeNext, setToken } from "@/lib/session";

const email = z.string().trim().toLowerCase().email().max(254);

export async function sendCode(formData: FormData) {
  const next = safeNext(formData.get("next"));
  const parsed = email.safeParse(formData.get("email"));
  if (!parsed.success) redirect(`/sign-in?error=email&next=${encodeURIComponent(next)}`);
  const res = await cpRaw("/api/auth/email-otp/send-verification-otp", { body: { email: parsed.data, type: "sign-in" } }).catch(() => null);
  if (!res || !res.ok) redirect(`/sign-in?error=${res?.status === 429 ? "slow" : "send"}&next=${encodeURIComponent(next)}`);
  redirect(`/sign-in/code?email=${encodeURIComponent(parsed.data)}&next=${encodeURIComponent(next)}`);
}

export async function verifyCode(formData: FormData) {
  const next = safeNext(formData.get("next"));
  const parsed = email.safeParse(formData.get("email"));
  const otp = String(formData.get("otp") ?? "").replace(/\s+/g, "");
  if (!parsed.success || !/^\d{8}$/.test(otp)) {
    redirect(`/sign-in/code?error=code&email=${encodeURIComponent(String(formData.get("email") ?? ""))}&next=${encodeURIComponent(next)}`);
  }
  const res = await cpRaw("/api/auth/sign-in/email-otp", { body: { email: parsed.data, otp, name: parsed.data.split("@")[0] } }).catch(() => null);
  const token = res?.ok ? res.headers.get("set-auth-token") : null;
  if (!token) redirect(`/sign-in/code?error=code&email=${encodeURIComponent(parsed.data)}&next=${encodeURIComponent(next)}`);
  await setToken(token);
  redirect(next);
}
