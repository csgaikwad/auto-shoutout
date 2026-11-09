import { NextResponse } from "next/server";
import { randomBytes } from "crypto";

export async function GET() {
  const state = randomBytes(32).toString("hex");

  const scopes = [
    "moderator:manage:shoutouts",
    "moderator:read:chatters",
    "user:read:chat",
    "user:write:chat",
    "user:bot",
    "chat:read",
    "chat:edit",
  ];

  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    redirect_uri: process.env.TWITCH_REDIRECT_URI,
    response_type: "code",
    scope: scopes.join(" "),
    state,
  });

  const response = NextResponse.redirect(
    `https://id.twitch.tv/oauth2/authorize?${params}`,
  );

  response.cookies.set("twitch_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return response;
}
