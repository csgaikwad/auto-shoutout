
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

import { getAppAccessToken, getUser } from "../../../../lib/twitch.js";
import { getModeratorAccess } from "../../../../lib/twitch-auth.js";
import { createClip } from "../../../../lib/clips.js";

const CLIP_CHANNELS = new Set(
  (process.env.TWITCH_CLIP_CHANNELS || "")
    .split(",")
    .map((channel) => channel.trim().toLowerCase())
    .filter(Boolean),
);

function isValidSecret(provided, expected) {
  if (!provided || !expected) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const channel = searchParams.get("channel")?.trim().toLowerCase();
    const username = searchParams.get("username")?.trim().toLowerCase();
    const key = searchParams.get("key");

    if (!isValidSecret(key, process.env.CLIP_API_SECRET)) {
      return new NextResponse("Unauthorized clip request.", {
        status: 401,
      });
    }

    if (!channel || !CLIP_CHANNELS.has(channel)) {
      return new NextResponse("This channel is not allowed to create clips.", {
        status: 403,
      });
    }

    if (username && !/^[a-z0-9_]{1,25}$/.test(username)) {
      return new NextResponse("Invalid username.", { status: 400 });
    }

    const { accessToken } = await getModeratorAccess();
    const appToken = await getAppAccessToken();

    const broadcaster = await getUser(channel, appToken);

    const clip = await createClip({
      accessToken,
      broadcasterId: broadcaster.id,
    });

    console.log("[CLIP] Clip creation requested:", {
      channel,
      username: username || "unknown",
      clipId: clip.id,
      editUrl: clip.edit_url,
    });

    return new NextResponse(
      `Clip request accepted in ${channel}! ${clip.edit_url}`,
      { status: 200 },
    );
  } catch (error) {
    console.error("[CLIP] Creation failed:", error.message);

    return new NextResponse("Clip creation failed. Check server logs.", {
      status: 500,
    });
  }
}
