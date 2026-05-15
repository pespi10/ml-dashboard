// src/lib/session.ts
// Manejo de sesión via cookies httpOnly (simple, sin dependencias extra)

import { cookies } from "next/headers";
import type { MLTokens } from "./ml-api";

const COOKIE_NAME = "ml_session";

/** Lee los tokens de la cookie de sesión */
export function getSession(): MLTokens | null {
  const cookieStore = cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  try {
    // En producción deberías encriptar esto con SESSION_SECRET
    return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

/** Guarda los tokens en la cookie (server-side) */
export function buildSessionCookieValue(tokens: MLTokens): string {
  return Buffer.from(JSON.stringify(tokens)).toString("base64");
}

export const SESSION_COOKIE_OPTIONS = {
  name: COOKIE_NAME,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 30, // 30 días
  path: "/",
};
