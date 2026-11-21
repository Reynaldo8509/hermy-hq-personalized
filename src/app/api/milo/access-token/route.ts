import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { prisma } from "@/lib/prisma";
import { internalSecretMatches } from "@/lib/internal-secret-auth.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MILO_EMAIL = String(process.env.MILO_ALLOWED_EMAIL || "").trim().toLowerCase();

type Credentials = { email?: string; refreshToken?: string };

function internal(request: NextRequest) {
  const secret = request.headers.get("x-internal-secret");
  return internalSecretMatches(secret, process.env.INTERNAL_API_SECRET);
}

// This route is only for the local Milo worker. It returns a short-lived Gmail
// access token, never the stored refresh token or Google client secret.
export async function GET(request: NextRequest) {
  if (!internal(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [credentials, state] = await Promise.all([
    prisma.dataStore.findUnique({ where: { key: "milo-gmail-credentials" } }),
    prisma.dataStore.findUnique({ where: { key: "milo-gmail-state" } }),
  ]);
  const auth = (credentials?.data || {}) as Credentials;
  if (!MILO_EMAIL || !auth.refreshToken || auth.email?.toLowerCase() !== MILO_EMAIL) {
    return NextResponse.json({ connected: false });
  }

  try {
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.NEXTAUTH_URL ? `${process.env.NEXTAUTH_URL}/api/auth/callback/google` : undefined,
    );
    client.setCredentials({ refresh_token: auth.refreshToken });
    const access = await client.getAccessToken();
    if (!access.token) throw new Error("Google did not return an access token");
    return NextResponse.json({
      connected: true,
      accessToken: access.token,
      state: state?.data || {},
    });
  } catch (error) {
    console.error("Milo Gmail token refresh failed", error);
    return NextResponse.json({ connected: false, error: "Gmail authorization needs reconnection" }, { status: 401 });
  }
}
