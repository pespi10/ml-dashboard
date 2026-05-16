import { NextRequest, NextResponse } from "next/server";
import { buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/login?error=${error}`, req.url));
  }

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=no_code", req.url));
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.ML_CLIENT_ID!,
      client_secret: process.env.ML_CLIENT_SECRET!,
      code,
      redirect_uri: process.env.ML_REDIRECT_URI!,
    });

    const res = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("ML token error:", JSON.stringify(data));
      return NextResponse.redirect(new URL(`/login?error=${data.error || "auth_failed"}&desc=${encodeURIComponent(data.message || "")}`, req.url));
    }

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
