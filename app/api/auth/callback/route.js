
import { NextResponse } from "next/server";
import { saveRefreshToken } from "../../../../lib/state.js";

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  const code = searchParams.get("code");
  const returnedState = searchParams.get("state");
  const expectedState = request.cookies.get("twitch_oauth_state")?.value;

  const response = (body, status = 200) => {
    const result = NextResponse.json(body, { status });

    result.cookies.set("twitch_oauth_state", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });

    return result;
  };

  if (!code || !returnedState || !expectedState) {
    return response({ error: "Missing OAuth parameters." }, 400);
  }

  if (returnedState !== expectedState) {
    return response({ error: "Invalid OAuth state." }, 403);
  }

  try {
    const params = new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: process.env.TWITCH_REDIRECT_URI,
    });

    const tokenResponse = await fetch(
      "https://id.twitch.tv/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      },
    );

    const data = await tokenResponse.json();

    if (!tokenResponse.ok || !data.refresh_token) {
      console.error("Twitch OAuth exchange failed:", data.message);

      return response(
        { error: "Unable to complete Twitch authorization." },
        400,
      );
    }

    await saveRefreshToken(data.refresh_token);

    return response({
      success: true,
      message: "Twitch account connected. Refresh token saved securely.",
    });
  } catch (error) {
    console.error("OAuth callback error:", error.message);

    return response(
      { error: "OAuth authorization failed." },
      500,
    );
  }
}
