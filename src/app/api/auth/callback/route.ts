// src/app/api/auth/callback/route.ts
// ML redirige acá con el code; lo intercambiamos por tokens

import { NextRequest, NextResponse } from "next/server";
import { buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(new URL("/login?error=no_code", req.url));
  }

  try {
    const res = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.ML_CLIENT_ID!,
        client_secret: process.env.ML_CLIENT_SECRET!,
        code,
        redirect_uri: process.env.ML_REDIRECT_URI!,
      }),
    });

    if (!res.ok) throw new Error("Token exchange failed");

    const data = await res.json();

    const tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      user_id: data.user_id,
    };

    const response = NextResponse.redirect(new URL("/dashboard", req.url));
    response.cookies.set({
      ...SESSION_COOKIE_OPTIONS,
      value: buildSessionCookieValue(tokens),
    });

    return response;
  } catch (err) {
    console.error("OAuth callback error:", err);
    return NextResponse.redirect(new URL("/login?error=auth_failed", req.url));
  }
}
