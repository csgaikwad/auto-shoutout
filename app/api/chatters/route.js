import { NextResponse } from "next/server";
import { refreshUserToken } from "@/lib/twitch-auth";
import { getAppAccessToken, getUser } from "@/lib/twitch";

export async function GET() {
  try {
    // 1. Get moderator user access token
    const userToken = await refreshUserToken();

    // 2. Validate the moderator account
    const validateResponse = await fetch(
      "https://id.twitch.tv/oauth2/validate",
      {
        headers: {
          Authorization: `OAuth ${userToken}`,
        },
        cache: "no-store",
      },
    );

    const moderator = await validateResponse.json();

    if (!validateResponse.ok) {
      throw new Error("Moderator token validation failed");
    }

    // 3. Get Jesse's broadcaster ID
    const appToken = await getAppAccessToken();
    const jesse = await getUser(process.env.JESSE_USERNAME, appToken);

    // 4. Get tracked usernames from environment variables
    const trackedUsers = (process.env.TRACKED_USERS || "")
      .split(",")
      .map((username) => username.trim().toLowerCase())
      .filter(Boolean);

    if (trackedUsers.length === 0) {
      throw new Error("No users configured in TRACKED_USERS");
    }

    // 5. Retrieve all chatters using pagination
    const presentUsers = new Set();
    let cursor = null;

    do {
      const params = new URLSearchParams({
        broadcaster_id: jesse.id,
        moderator_id: moderator.user_id,
        first: "1000",
      });

      if (cursor) {
        params.set("after", cursor);
      }

      const response = await fetch(
        `https://api.twitch.tv/helix/chat/chatters?${params}`,
        {
          headers: {
            "Client-ID": process.env.TWITCH_CLIENT_ID,
            Authorization: `Bearer ${userToken}`,
          },
          cache: "no-store",
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || "Unable to retrieve chatters");
      }

      // Keep only users we're tracking
      for (const chatter of result.data || []) {
        const username = chatter.user_login.toLowerCase();

        if (trackedUsers.includes(username)) {
          presentUsers.add(username);
        }
      }

      cursor = result.pagination?.cursor || null;
    } while (cursor);

    // 6. Return each tracked user's presence
    const users = Object.fromEntries(
      trackedUsers.map((username) => [
        username,
        presentUsers.has(username),
      ]),
    );

    return NextResponse.json({
      success: true,
      users,
    });

  } catch (error) {
    console.error("Chatters API error:", error);

    return NextResponse.json(
      {
        success: false,
        error: error.message || "Something went wrong",
      },
      { status: 500 },
    );
  }
}