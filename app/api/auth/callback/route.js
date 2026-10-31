
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const cookieStore = await cookies();
  const savedState = cookieStore.get("twitch_oauth_state")?.value;

  if (error) {
    return NextResponse.json(
      { error: "Twitch authorization was denied." },
      { status: 400 }
    );
  }

  if (!state || !savedState || state !== savedState) {
    return NextResponse.json(
      { error: "Invalid OAuth state." },
      { status: 403 }
    );
  }

  if (!code) {
    return NextResponse.json(
      { error: "Authorization code missing." },
      { status: 400 }
    );
  }

  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: process.env.TWITCH_REDIRECT_URI,
  });

  try {
    const twitchResponse = await fetch(
      "https://id.twitch.tv/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      }
    );

    const tokens = await twitchResponse.json();

    if (!twitchResponse.ok) {
      return NextResponse.json(
        { error: "Token exchange failed.", details: tokens },
        { status: twitchResponse.status }
      );
    }

    const response = NextResponse.json({
      message: "Twitch authentication successful!",
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      scopes: tokens.scope,
    });

    response.cookies.delete("twitch_oauth_state");

    return response;
  } catch (error) {
    console.error("OAuth error:", error);

    return NextResponse.json(
      { error: "Something went wrong during authentication." },
      { status: 500 }
    );
  }
}
