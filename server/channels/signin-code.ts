// Sign-in codes are refused before channel receipts or question answers retain raw text.
import { looksLikeSignInCode } from "../../shared/signin-code-shape.mjs";
import { cloudHomeCopy } from "../cloud-home/copy.ts";
export function channelSigninCodeRefusal(text: string): string | undefined {
  return process.env.MURAGE_CLOUD_ROLE === "home" && looksLikeSignInCode(text) ? cloudHomeCopy.signinCodeInChat : undefined;
}
