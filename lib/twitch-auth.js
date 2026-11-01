
import {
  loadRefreshToken,
  saveRefreshToken,
  loadCachedModeratorAccess,
  saveCachedModeratorAccess,
} from "./state.js";

export async function refreshUserToken() {
  const cached = await loadCachedModeratorAccess();

  if (cached) {
    return cached.accessToken;
  }

  const refreshToken =
    (await loadRefreshToken()) ||
    process.env.TWITCH_USER_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error("Twitch refresh token is missing.");
  }

  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
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
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Token refresh failed.");
  }

  if (data.refresh_token) {
    await saveRefreshToken(data.refresh_token);
  }

  const validateResponse = await fetch(
    "https://id.twitch.tv/oauth2/validate",
    {
      headers: {
        Authorization: `OAuth ${data.access_token}`,
      },
      cache: "no-store",
    },
  );

  const moderator = await validateResponse.json();

  if (!validateResponse.ok) {
    throw new Error("Unable to validate Twitch moderator.");
  }

  const requiredScopes = [
    "moderator:manage:shoutouts",
    "user:read:chat",
    "user:bot",
  ];

  for (const scope of requiredScopes) {
    if (!moderator.scopes?.includes(scope)) {
      throw new Error(`Missing Twitch OAuth scope: ${scope}`);
    }
  }

  await saveCachedModeratorAccess(
    data.access_token,
    data.expires_in,
    moderator,
  );

  return data.access_token;
}

export async function getModeratorAccess() {
  const accessToken = await refreshUserToken();

  const cached = await loadCachedModeratorAccess();

  if (cached) {
    return cached;
  }

  const response = await fetch(
    "https://id.twitch.tv/oauth2/validate",
    {
      headers: {
        Authorization: `OAuth ${accessToken}`,
      },
      cache: "no-store",
    },
  );

  const moderator = await response.json();

  if (!response.ok) {
    throw new Error("Unable to validate Twitch moderator.");
  }

  return { accessToken, moderator };
}
