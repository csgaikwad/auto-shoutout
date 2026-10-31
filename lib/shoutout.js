
export async function sendShoutout({
  accessToken,
  fromBroadcasterId,
  toBroadcasterId,
  moderatorId,
}) {
  const params = new URLSearchParams({
    from_broadcaster_id: fromBroadcasterId,
    to_broadcaster_id: toBroadcasterId,
    moderator_id: moderatorId,
  });

  const response = await fetch(
    `https://api.twitch.tv/helix/chat/shoutouts?${params}`,
    {
      method: "POST",
      headers: {
        "Client-ID": process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (response.status !== 204) {
    const error = new Error(
      (await response.text()) || `Shoutout failed: ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }

  return true;
}
