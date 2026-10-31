import { NextResponse } from "next/server";
import { getAppAccessToken, getUser } from "../../../../lib/twitch.js";

export async function POST() {
  try {
    const appToken = await getAppAccessToken();

    const refreshResponse = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: process.env.TWITCH_USER_REFRESH_TOKEN,
      }),
    });

    const tokens = await refreshResponse.json();

    if (!refreshResponse.ok) {
      throw new Error("Moderator token refresh failed");
    }

    const validateResponse = await fetch(
      "https://id.twitch.tv/oauth2/validate",
      {
        headers: {
          Authorization: `OAuth ${tokens.access_token}`,
        },
      },
    );

    const moderator = await validateResponse.json();

    if (!validateResponse.ok || !moderator.user_id) {
      throw new Error("Moderator validation failed");
    }

    const jesse = await getUser(process.env.JESSE_USERNAME, appToken);

    const response = await fetch(
      "https://api.twitch.tv/helix/eventsub/subscriptions",
      {
        method: "POST",
        headers: {
          "Client-ID": process.env.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${appToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "channel.shoutout.create",
          version: "1",
          condition: {
            broadcaster_user_id: jesse.id,
            moderator_user_id: moderator.user_id,
          },
          transport: {
            method: "webhook",
            callback: `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twitch`,
            secret: process.env.TWITCH_EVENTSUB_SECRET,
          },
        }),
      },
    );

    const data = await response.json();

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Subscription setup failed" },
      { status: 500 },
    );
  }
}
