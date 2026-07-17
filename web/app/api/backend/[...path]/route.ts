import { NextRequest, NextResponse } from "next/server";
import { SignJWT } from "jose";
import { auth, type ProviderSession } from "@/auth";

// The auth bridge: the browser never calls the Go API directly. This route
// reads the (encrypted) Auth.js session server-side, mints a 5-minute HS256
// JWT the Go server can verify with the shared API_JWT_SECRET, and forwards
// the request. Also hides the Render URL and avoids CORS.
const secret = new TextEncoder().encode(process.env.API_JWT_SECRET);

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const session = (await auth()) as ProviderSession | null;
  if (!session?.user?.email || !session.provider || !session.providerId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = await new SignJWT({
    email: session.user.email,
    name: session.user.name ?? "",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(`${session.provider}:${session.providerId}`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);

  const { path } = await params;
  const url = `${process.env.BACKEND_URL}/api/v1/${path.join("/")}${req.nextUrl.search}`;

  const resp = await fetch(url, {
    method: req.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
    cache: "no-store",
  });

  return new NextResponse(resp.body, {
    status: resp.status,
    headers: {
      "Content-Type": resp.headers.get("Content-Type") ?? "application/json",
    },
  });
}

export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
