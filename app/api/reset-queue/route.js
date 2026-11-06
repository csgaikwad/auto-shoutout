import { randomUUID, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { connectDB } from "../../../lib/mongodb.js";
import {
  acquireCronLock,
  releaseCronLock,
} from "../../../lib/state.js";

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

  const { searchParams } = new URL(request.url);

  if (searchParams.get("confirm") !== "yes") {
    return NextResponse.json(
      { error: "Confirmation required. Use ?confirm=yes" },
      { status: 400 },
    );
  }

  const owner = randomUUID();

  try {
    const acquired = await acquireCronLock(owner, Date.now() + 55 * 1000);

    if (!acquired) {
      return NextResponse.json(
        { error: "Queue processor is currently running. Try again later." },
        { status: 409 },
      );
    }

    try {
      const db = await connectDB();

      await db.collection("worker_state").updateOne(
        { _id: "main" },
        {
          $set: {
            queue: [],
            pendingUsers: [],
            shoutedUsers: {},
            nextShoutoutAt: 0,
          },
        },
        { upsert: true },
      );

      console.log("[RESET] Queue and shoutout history cleared.");

      return NextResponse.json({
        success: true,
        message: "Queue and shoutout history cleared successfully.",
      });
    } finally {
      await releaseCronLock(owner);
    }
  } catch (error) {
    console.error("[RESET] Failed:", error.message);

    return NextResponse.json(
      { error: error.message },
      { status: 500 },
    );
  }
}
