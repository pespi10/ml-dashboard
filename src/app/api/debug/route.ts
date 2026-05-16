export async function GET() {
  return Response.json({
    ML_CLIENT_ID: !!process.env.ML_CLIENT_ID,
    ML_CLIENT_SECRET: !!process.env.ML_CLIENT_SECRET,
    ML_REDIRECT_URI: process.env.ML_REDIRECT_URI,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
}
