import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as cookie from "cookie";

export function middleware(request: NextRequest) {
  const cookies = cookie.parse(request.headers.get("cookie") || "");

  const sessionToken = cookies["next-auth.session-token"] || cookies["__Secure-next-auth.session-token"];

  const protectedRoutes = ["/project", "/projects"];

  if (request.nextUrl.pathname.startsWith("/join")) {
    if (!sessionToken) {
      const login = new URL("/login", request.url);
      login.searchParams.set("callbackUrl", request.nextUrl.pathname);
      return NextResponse.redirect(login);
    }
  }

  if (protectedRoutes.some((route) => request.nextUrl.pathname.startsWith(route))) {
    if (!sessionToken) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/modules/:path*", "/project/:path*", "/join/:path*"],
};