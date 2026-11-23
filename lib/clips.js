
export async function createClip({ accessToken, broadcasterId }) {
  const url = new URL("https://api.twitch.tv/helix/clips");

  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("duration", "60");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Client-ID": process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  const data = await response.json();

  if (!response.ok || !data.data?.[0]?.id) {
    throw new Error(data.message || "Failed to create Twitch clip.");
  }

  return data.data[0];
}
