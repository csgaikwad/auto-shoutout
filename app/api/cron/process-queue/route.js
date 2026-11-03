import { randomUUID, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import {
  loadWorkerState,
  removeQueuedUser,
  recordShoutout,
  updateNextShoutoutAt,
  acquireCronLock,
  releaseCronLock,
  resetShoutedUsersDaily,
} from "../../../../lib/state.js";
import { getModeratorAccess } from "../../../../lib/twitch-auth.js";
import { getAppAccessToken, getUser } from "../../../../lib/twitch.js";
import { sendShoutout } from "../../../../lib/shoutout.js";

const SHOUTOUT_COOLDOWN = 2 * 60 * 1000;
const REPEAT_PREVENTION = 20 * 60 * 60 * 1000;

const CHANNEL = process.env.JESSE_USERNAME?.toLowerCase();

function isAuthorized(request) {
  const expected = process.env.CRON_SECRET;
  const received = request.headers.get("authorization") || "";

  if (!expected) return false;

  const expectedBuffer = Buffer.from(`Bearer ${expected}`);
  const receivedBuffer = Buffer.from(received);

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export async function POST(request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const owner = randomUUID();

  try {
    const acquired = await acquireCronLock(owner, Date.now() + 55 * 1000);

    if (!acquired) {
      return NextResponse.json({
        success: true,
        message: "Another queue processor is running.",
      });
    }

    try {
      if (!CHANNEL) {
        throw new Error("JESSE_USERNAME is missing.");
      }

      await resetShoutedUsersDaily();

      let state = await loadWorkerState();
      console.log("[CRON] Queue checked:", state.queue);
      console.log("[CRON] Next shoutout:", new Date(state.nextShoutoutAt));

      if (state.queue.length === 0) {
        console.log("[CRON] Queue empty. Nothing to process.");

        return NextResponse.json({
          success: true,
          message: "Queue is empty.",
        });
      }

      const now = Date.now();

      if (now < state.nextShoutoutAt) {
        console.log("[CRON] Cooldown active.");

        return NextResponse.json({
          success: true,
          message: "Shoutout cooldown active.",
          nextShoutoutAt: state.nextShoutoutAt,
        });
      }

      const username = state.queue[0];

      const lastShoutout = state.shoutedUsers[username];

      if (lastShoutout && now - lastShoutout < REPEAT_PREVENTION) {
        await removeQueuedUser(username);

        return NextResponse.json({
          success: true,
          message: "User is still within repeat prevention.",
          username,
        });
      }

      const trackedUsers = new Set(
        (process.env.TRACKED_USERS || "")
          .split(",")
          .map((user) => user.trim().toLowerCase())
          .filter(Boolean),
      );

      if (!trackedUsers.has(username)) {
        await removeQueuedUser(username);

        return NextResponse.json({
          success: true,
          message: "User is no longer tracked.",
        });
      }

      const { accessToken, moderator } = await getModeratorAccess();

      const appToken = await getAppAccessToken();
      const jesse = await getUser(CHANNEL, appToken);

      const target = await getUser(username, appToken);

      if (!target?.id) {
        await removeQueuedUser(username);

        return NextResponse.json({
          success: true,
          message: "Twitch user not found; removed from queue.",
          username,
        });
      }

      try {
        console.log("[SHOUTOUT] Sending to:", username);
        await sendShoutout({
          accessToken,
          fromBroadcasterId: jesse.id,
          toBroadcasterId: target.id,
          moderatorId: moderator.user_id,
        });
        console.log("[SHOUTOUT] Successfully sent:", username);
      } catch (error) {
        if (error.status !== 401) throw error;
        console.error("[ERROR] Cron processing failed:", error);

        // Refresh the moderator token and retry once.
        const refreshed = await getModeratorAccess();

        await sendShoutout({
          accessToken: refreshed.accessToken,
          fromBroadcasterId: jesse.id,
          toBroadcasterId: target.id,
          moderatorId: refreshed.moderator.user_id,
        });
      }

      const completedAt = Date.now();

      await recordShoutout(
        username,
        completedAt,
        completedAt + SHOUTOUT_COOLDOWN,
      );

      console.log(`Shoutout sent to ${username}.`);

      return NextResponse.json({
        success: true,
        message: "Shoutout sent.",
        username,
      });
    } finally {
      await releaseCronLock(owner);
    }
  } catch (error) {
    console.error("Cron queue error:", error.message);

    if (error.status === 429) {
      await updateNextShoutoutAt(Date.now() + SHOUTOUT_COOLDOWN).catch(
        () => {},
      );
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
