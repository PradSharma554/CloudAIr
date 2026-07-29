import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Public routes: the landing page and login. Everything else needs a session.
const publicPaths = new Set(["/", "/login"]);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  if (!req.auth && !publicPaths.has(pathname)) {
    const url = new URL("/login", req.nextUrl);
    return NextResponse.redirect(url);
  }
  if (req.auth && pathname === "/login") {
    return NextResponse.redirect(new URL("/sites", req.nextUrl));
  }
  return NextResponse.next();
});

export const config = {
  // Protect everything except auth endpoints and static assets.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
