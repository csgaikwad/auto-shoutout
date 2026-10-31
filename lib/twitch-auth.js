
export async function refreshUserToken() {
  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: process.env.TWITCH_USER_REFRESH_TOKEN,
  });

  const response = await fetch(
    "https://id.twitch.tv/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
      cache: "no-store",
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Token refresh failed");
  }

  // Twitch can rotate the refresh token.
  // Keep the new value for the next refresh.
  if (data.refresh_token) {
    console.log("NEW_TWITCH_REFRESH_TOKEN:", data.refresh_token);
  }

  return data.access_token;
}
