
import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { loadWorkerState, saveWorkerState } from "../../../../lib/state.js";

export async function POST(request) {
  try {
    const messageId = request.headers.get("twitch-eventsub-message-id");
    const timestamp = request.headers.get("twitch-eventsub-message-timestamp");
    const signature = request.headers.get("twitch-eventsub-message-signature");
    const messageType = request.headers.get("twitch-eventsub-message-type");

    const body = await request.text();

    // Verify that the notification came from Twitch.
    const hmac = createHmac("sha256", process.env.TWITCH_EVENTSUB_SECRET);
    hmac.update(messageId + timestamp + body);

    const expected = Buffer.from(`sha256=${hmac.digest("hex")}`);
    const received = Buffer.from(signature || "");

    if (
      !messageId ||
      !timestamp ||
      !signature ||
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      return new NextResponse("Invalid signature", { status: 403 });
    }

    const payload = JSON.parse(body);

    // Twitch subscription verification.
    if (messageType === "webhook_callback_verification") {
      return new NextResponse(payload.challenge, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (messageType === "notification") {
      const event = payload.event;

      if (payload.subscription.type === "channel.shoutout.create") {
        const username = event.to_broadcaster_user_login.toLowerCase();

        const state = await loadWorkerState();

        state.queue = state.queue.filter(
          (user) => user !== username,
        );

        state.pendingUsers = state.pendingUsers.filter(
          (user) => user !== username,
        );

        state.shoutedUsers[username] = Date.now();

        state.nextShoutoutAt = Math.max(
          state.nextShoutoutAt,
          new Date(event.cooldown_ends_at).getTime(),
        );

        await saveWorkerState(state);

        console.log(`Shoutout detected: ${username}`);
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("EventSub webhook error:", error);
    return new NextResponse("Webhook error", { status: 500 });
  }
}
