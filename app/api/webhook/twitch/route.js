import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import {
  enqueueUser,
  recordShoutout,
  markEventProcessed,
} from "../../../../lib/state.js";

import { getModeratorAccess } from "../../../../lib/twitch-auth.js";
import { sendChatMessage } from "../../../../lib/chat.js";

const TRACKED_USERS = new Set(
  (process.env.TRACKED_USERS || "")
    .split(",")
    .map((user) => user.trim().toLowerCase())
    .filter(Boolean),
);

const CHANNEL = process.env.JESSE_USERNAME?.toLowerCase();

export async function POST(request) {
  try {
    const messageId = request.headers.get("twitch-eventsub-message-id");
    const timestamp = request.headers.get("twitch-eventsub-message-timestamp");
    const signature = request.headers.get("twitch-eventsub-message-signature");
    const messageType = request.headers.get("twitch-eventsub-message-type");

    const secret = process.env.TWITCH_EVENTSUB_SECRET;

    if (!secret || !messageId || !timestamp || !signature || !messageType) {
      return new NextResponse("Missing webhook headers or secret", {
        status: 403,
      });
    }

    const timestampMs = Date.parse(timestamp);

    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > 10 * 60 * 1000
    ) {
      return new NextResponse("Expired webhook message", {
        status: 403,
      });
    }

    const body = await request.text();

    const hmac = createHmac("sha256", secret);
    hmac.update(messageId + timestamp + body);

    const expected = Buffer.from(`sha256=${hmac.digest("hex")}`);
    const received = Buffer.from(signature);

    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      return new NextResponse("Invalid signature", {
        status: 403,
      });
    }

    const payload = JSON.parse(body);

    if (messageType === "webhook_callback_verification") {
      return new NextResponse(payload.challenge, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
        },
      });
    }

    if (messageType !== "notification") {
      return new NextResponse(null, { status: 204 });
    }

    const event = payload.event;
    const subscriptionType = payload.subscription?.type;

    if (event?.broadcaster_user_login?.toLowerCase() !== CHANNEL) {
      return new NextResponse(null, { status: 204 });
    }

    if (subscriptionType === "channel.chat.message") {
      const username = event.chatter_user_login?.toLowerCase();

      if (subscriptionType === "channel.chat.message") {
        const username = event.chatter_user_login?.toLowerCase();
        const message = event.message?.text?.trim().toLowerCase();

        //  " !wait test "
        if (message === "!wait") {
          console.log(
            `[CHAT TEST] ${event.chatter_user_name} used !wait — waitinggg`,
          );

          // Actual chat response (testing)
          // const { accessToken, moderator } = await getModeratorAccess();

          // await sendChatMessage({
          //   accessToken,
          //   broadcasterId: event.broadcaster_user_id,
          //   senderId: moderator.user_id,
          //   message: "waitinggg",
          // });
        }
      }

      // shoutout queue logic

      if (
        username &&
        TRACKED_USERS.has(username) &&
        /^[a-z0-9_]{1,25}$/.test(username)
      ) {
        await enqueueUser(username);
        console.log(`Queued chat user: ${username}`);
      }
    }

    if (subscriptionType === "channel.shoutout.create") {
      const username = event.to_broadcaster_user_login?.toLowerCase();

      if (username && /^[a-z0-9_]{1,25}$/.test(username)) {
        const cooldown = Date.parse(event.cooldown_ends_at);

        await recordShoutout(
          username,
          Date.now(),
          Number.isFinite(cooldown) ? cooldown : Date.now(),
        );

        console.log(`Shoutout detected: ${username}`);
      }
    }

    // Queue and shoutout updates are idempotent, so mark after processing.
    await markEventProcessed(messageId);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("EventSub webhook error:", error.message);

    return new NextResponse("Webhook error", { status: 500 });
  }
}
