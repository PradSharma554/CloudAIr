import { NextResponse } from "next/server";
import { auth } from "@/auth";

export default auth((req) => {
  const { pathname } = req.nextUrl;
  if (!req.auth && pathname !== "/login") {
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
