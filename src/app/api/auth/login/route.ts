import { NextResponse } from "next/server";

export async function GET() {
  const clientId = process.env.ML_CLIENT_ID!;
  const redirectUri = process.env.ML_REDIRECT_URI!;

  const authUrl = new URL("https://auth.mercadolibre.com.ar/authorization");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "offline_access read");

  return NextResponse.redirect(authUrl.toString());
}
