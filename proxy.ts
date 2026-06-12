import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const cookie = request.cookies.get("site-password");

  // Already verified — let the request through
  if (cookie?.value === process.env.SITE_PASSWORD) {
    return NextResponse.next();
  }

  // Not verified — send to the password page
  const url = request.nextUrl.clone();
  if (url.pathname !== "/password") {
    url.pathname = "/password";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except static assets, the password page, and the verify endpoint
  matcher: ["/((?!_next|favicon.ico|password|api/verify-password).*)"],
};
