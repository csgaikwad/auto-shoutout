
import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import {
  isEventProcessed,
  markEventProcessed,
  recordShoutout,
} from "../../../../lib/state.js";

export async function POST(request) {
  try {
    const messageId = request.headers.get(
      "twitch-eventsub-message-id",
    );
    const timestamp = request.headers.get(
      "twitch-eventsub-message-timestamp",
    );
    const signature = request.headers.get(
      "twitch-eventsub-message-signature",
    );
    const messageType = request.headers.get(
      "twitch-eventsub-message-type",
    );

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

    if (messageType === "notification") {
      if (
        payload.subscription?.type === "channel.shoutout.create"
      ) {
        if (await isEventProcessed(messageId)) {
          return new NextResponse(null, { status: 204 });
        }

        const event = payload.event;
        const username = event?.to_broadcaster_user_login?.toLowerCase();

        if (!username || !/^[a-z0-9_]{1,25}$/.test(username)) {
          return new NextResponse("Invalid target username", {
            status: 400,
          });
        }

        const shoutoutTime = Date.parse(event.started_at);
        const cooldownTime = Date.parse(event.cooldown_ends_at);

        await recordShoutout(
          username,
          Number.isFinite(shoutoutTime) ? shoutoutTime : Date.now(),
          Number.isFinite(cooldownTime) ? cooldownTime : Date.now(),
        );

        await markEventProcessed(messageId);

        console.log(`Shoutout detected: ${username}`);
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("EventSub webhook error:", error.message);

    return new NextResponse("Webhook error", {
      status: 500,
    });
  }
}
