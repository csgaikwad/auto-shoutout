
import { NextResponse } from "next/server";
import { getAppAccessToken, getUser } from "../../../../lib/twitch.js";
import { getModeratorAccess } from "../../../../lib/twitch-auth.js";


export async function POST(request) {
  try {
    if (
      !process.env.EVENTSUB_SETUP_SECRET ||
      request.headers.get("authorization") !==
        `Bearer ${process.env.EVENTSUB_SETUP_SECRET}`
    ) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    const channel = process.env.JESSE_USERNAME?.toLowerCase();
    const callback = `${process.env.NEXT_PUBLIC_APP_URL}/api/webhook/twitch`;

    if (!channel || !process.env.TWITCH_EVENTSUB_SECRET) {
      throw new Error("Missing channel or EventSub configuration.");
    }

    const { moderator } = await getModeratorAccess();
    const appToken = await getAppAccessToken();
    const jesse = await getUser(channel, appToken);

    const subscriptions = [
      {
        type: "channel.chat.message",
        version: "1",
        condition: {
          broadcaster_user_id: jesse.id,
          user_id: moderator.user_id,
        },
      },
      {
        type: "channel.shoutout.create",
        version: "1",
        condition: {
          broadcaster_user_id: jesse.id,
          moderator_user_id: moderator.user_id,
        },
      },
    ];

    const results = [];

    for (const subscription of subscriptions) {
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
            ...subscription,
            transport: {
              method: "webhook",
              callback,
              secret: process.env.TWITCH_EVENTSUB_SECRET,
            },
          }),
        },
      );

      const data = await response.json();

      if (response.status === 409) {
        results.push({
          type: subscription.type,
          status: "already_exists",
        });
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `${subscription.type}: ${JSON.stringify(data)}`,
        );
      }

      results.push({
        type: subscription.type,
        status: data.data?.[0]?.status || "pending",
      });
    }

    return NextResponse.json({
      success: true,
      subscriptions: results,
    });
  } catch (error) {
    console.error("EventSub setup error:", error.message);

    return NextResponse.json(
      { error: error.message },
      { status: 500 },
    );
  }
}
