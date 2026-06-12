import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  let password: string;
  try {
    ({ password } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (process.env.SITE_PASSWORD && password === process.env.SITE_PASSWORD) {
    const response = NextResponse.json({ success: true });
    response.cookies.set("site-password", password, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7, // stay verified for 7 days
    });
    return response;
  }

  return NextResponse.json({ error: "Invalid password" }, { status: 401 });
}
