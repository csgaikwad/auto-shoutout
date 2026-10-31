
import WebSocket from "ws";
import { getUser } from "./lib/twitch.js";
import { sendShoutout } from "./lib/shoutout.js";
import {
  loadWorkerState,
  enqueueUser,
  removeQueuedUser,
  recordShoutout,
  updateNextShoutoutAt,
  loadRefreshToken,
  saveRefreshToken,
} from "./lib/state.js";
import { closeDB } from "./lib/mongodb.js";

const CHANNEL = process.env.JESSE_USERNAME?.toLowerCase();

const TRACKED_USERS = new Set(
  (process.env.TRACKED_USERS || "")
    .split(",")
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean),
);

const SHOUTOUT_COOLDOWN = 2 * 60 * 1000;
const RETRY_DELAY = 60 * 1000;
const REPEAT_PREVENTION = 20 * 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN = 5 * 60 * 1000;

let refreshToken;
let userAccessToken;
let userTokenExpiresAt = 0;
let userRefreshPromise = null;

let appAccessToken;
let appTokenExpiresAt = 0;
let appRefreshPromise = null;

let moderatorId;
let moderatorLogin;
let jesseId;

let ircSocket;
let ircGeneration = 0;
let reconnectAttempts = 0;
let reconnectTimer = null;
let tokenRefreshTimer = null;
let queueInterval = null;

let processing = false;
let shuttingDown = false;

const userIds = new Map();

async function refreshUserAccessToken() {
  if (userRefreshPromise) return userRefreshPromise;

  userRefreshPromise = (async () => {
    const params = new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "User token refresh failed");
    }

    userAccessToken = data.access_token;
    userTokenExpiresAt = Date.now() + data.expires_in * 1000;

    if (data.refresh_token && data.refresh_token !== refreshToken) {
      refreshToken = data.refresh_token;
      await saveRefreshToken(refreshToken);
      console.log("Rotated refresh token saved.");
    }

    scheduleUserTokenRefresh();

    return userAccessToken;
  })();

  try {
    return await userRefreshPromise;
  } finally {
    userRefreshPromise = null;
  }
}

async function getValidUserAccessToken() {
  if (
    !userAccessToken ||
    Date.now() >= userTokenExpiresAt - TOKEN_REFRESH_MARGIN
  ) {
    const previousToken = userAccessToken;
    const token = await refreshUserAccessToken();

    if (previousToken && token !== previousToken && moderatorLogin) {
      connectIRC(token, moderatorLogin);
    }
  }

  return userAccessToken;
}

function scheduleUserTokenRefresh() {
  clearTimeout(tokenRefreshTimer);

  const delay = Math.max(
    1000,
    userTokenExpiresAt - Date.now() - TOKEN_REFRESH_MARGIN,
  );

  tokenRefreshTimer = setTimeout(async () => {
    try {
      const previousToken = userAccessToken;
      const token = await refreshUserAccessToken();

      if (token !== previousToken && moderatorLogin) {
        console.log("Reconnecting IRC with refreshed token.");
        connectIRC(token, moderatorLogin);
      }
    } catch (error) {
      console.error("Scheduled token refresh failed:", error.message);

      tokenRefreshTimer = setTimeout(async () => {
        try {
          const previousToken = userAccessToken;
          const token = await refreshUserAccessToken();

          if (token !== previousToken && moderatorLogin) {
            connectIRC(token, moderatorLogin);
          }
        } catch (retryError) {
          console.error("Token refresh retry failed:", retryError.message);
          scheduleUserTokenRetry();
        }
      }, 60 * 1000);
    }
  }, delay);
}

function scheduleUserTokenRetry() {
  clearTimeout(tokenRefreshTimer);

  tokenRefreshTimer = setTimeout(async () => {
    try {
      const previousToken = userAccessToken;
      const token = await refreshUserAccessToken();

      if (token !== previousToken && moderatorLogin) {
        connectIRC(token, moderatorLogin);
      }
    } catch (error) {
      console.error("Token refresh retry failed:", error.message);
      scheduleUserTokenRetry();
    }
  }, 60 * 1000);
}

async function getValidAppAccessToken() {
  if (
    appAccessToken &&
    Date.now() < appTokenExpiresAt - TOKEN_REFRESH_MARGIN
  ) {
    return appAccessToken;
  }

  if (appRefreshPromise) return appRefreshPromise;

  appRefreshPromise = (async () => {
    const params = new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    });

    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "App token refresh failed");
    }

    appAccessToken = data.access_token;
    appTokenExpiresAt = Date.now() + data.expires_in * 1000;

    return appAccessToken;
  })();

  try {
    return await appRefreshPromise;
  } finally {
    appRefreshPromise = null;
  }
}

function connectIRC(accessToken, login) {
  if (shuttingDown) return;

  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const generation = ++ircGeneration;
  const previousSocket = ircSocket;

  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ircSocket = ws;

  if (
    previousSocket &&
    previousSocket.readyState !== WebSocket.CLOSED
  ) {
    previousSocket.terminate();
  }

  ws.on("open", () => {
    if (generation !== ircGeneration) return;

    reconnectAttempts = 0;

    ws.send(`PASS oauth:${accessToken}`);
    ws.send(`NICK ${login}`);
    ws.send("CAP REQ :twitch.tv/membership");
    ws.send(`JOIN #${CHANNEL}`);

    console.log("Connected to Twitch IRC.");
  });

  ws.on("message", async (data) => {
    if (generation !== ircGeneration || shuttingDown) return;

    try {
      const messages = data.toString().split("\r\n");

      for (const message of messages) {
        if (!message) continue;

        if (message.startsWith("PING")) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send("PONG :tmi.twitch.tv");
          }
          continue;
        }

        const match = message.match(/^:([^!]+)![^ ]+ PRIVMSG #/i);
        if (!match) continue;

        const username = match[1].toLowerCase();

        if (!TRACKED_USERS.has(username)) continue;

        const state = await loadWorkerState();
        const lastShoutout = state.shoutedUsers[username];

        if (
          lastShoutout &&
          Date.now() - lastShoutout < REPEAT_PREVENTION
        ) {
          continue;
        }

        if (state.pendingUsers.includes(username)) continue;

        const added = await enqueueUser(username);

        if (added) {
          console.log(`${username} added to the shoutout queue.`);
        }
      }
    } catch (error) {
      console.error("IRC message processing error:", error.message);
    }
  });

  ws.on("error", (error) => {
    console.error("IRC error:", error.message);

    if (generation === ircGeneration) {
      ws.terminate();
    }
  });

  ws.on("close", () => {
    if (generation !== ircGeneration || shuttingDown) return;

    console.log("IRC disconnected.");

    if (reconnectTimer) return;

    const delay = Math.min(5000 * 2 ** reconnectAttempts, 60000);
    reconnectAttempts++;

    console.log(`Reconnecting in ${delay / 1000} seconds...`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectIRC(userAccessToken, moderatorLogin);
    }, delay);
  });
}

async function processQueue() {
  if (processing || shuttingDown) return;

  processing = true;

  try {
    const state = await loadWorkerState();

    if (state.queue.length === 0 || Date.now() < state.nextShoutoutAt) {
      return;
    }

    const username = state.queue[0];

    if (!TRACKED_USERS.has(username)) {
      await removeQueuedUser(username);
      return;
    }

    const lastShoutout = state.shoutedUsers[username];

    if (
      lastShoutout &&
      Date.now() - lastShoutout < REPEAT_PREVENTION
    ) {
      await removeQueuedUser(username);
      return;
    }

    let targetId = userIds.get(username);

    if (!targetId) {
      const appToken = await getValidAppAccessToken();
      const user = await getUser(username, appToken);

      if (!user?.id) {
        throw new Error(`Unable to find Twitch user: ${username}`);
      }

      targetId = user.id;
      userIds.set(username, targetId);
    }

    let accessToken = await getValidUserAccessToken();

    try {
      await sendShoutout({
        accessToken,
        fromBroadcasterId: jesseId,
        toBroadcasterId: targetId,
        moderatorId,
      });
    } catch (error) {
      if (error.status !== 401) throw error;

      console.log("User token rejected. Refreshing and retrying.");

      accessToken = await refreshUserAccessToken();
      connectIRC(accessToken, moderatorLogin);

      await sendShoutout({
        accessToken,
        fromBroadcasterId: jesseId,
        toBroadcasterId: targetId,
        moderatorId,
      });
    }

    const now = Date.now();

    await recordShoutout(
      username,
      now,
      now + SHOUTOUT_COOLDOWN,
    );

    console.log(`Shoutout successful: ${username}`);
  } catch (error) {
    console.error("Shoutout processing failed:", error.message);

    const delay =
      error.status === 429 ? SHOUTOUT_COOLDOWN : RETRY_DELAY;

    await updateNextShoutoutAt(Date.now() + delay);
  } finally {
    processing = false;
  }
}

async function startWorker() {
  if (
    !CHANNEL ||
    TRACKED_USERS.size === 0 ||
    !process.env.TWITCH_CLIENT_ID ||
    !process.env.TWITCH_CLIENT_SECRET
  ) {
    throw new Error("Configure Twitch credentials, JESSE_USERNAME and TRACKED_USERS.");
  }

  const savedToken = await loadRefreshToken();

  refreshToken =
    savedToken || process.env.TWITCH_USER_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error("Twitch refresh token is missing.");
  }

  const savedState = await loadWorkerState();

  console.log(`Restored ${savedState.queue.length} queued shoutouts.`);

  await refreshUserAccessToken();

  const validateResponse = await fetch(
    "https://id.twitch.tv/oauth2/validate",
    {
      headers: {
        Authorization: `OAuth ${userAccessToken}`,
      },
    },
  );

  const moderator = await validateResponse.json();

  if (!validateResponse.ok) {
    throw new Error("Unable to validate moderator account.");
  }

  moderatorId = moderator.user_id;
  moderatorLogin = moderator.login;

  const appToken = await getValidAppAccessToken();
  const jesse = await getUser(CHANNEL, appToken);

  if (!jesse?.id) {
    throw new Error(`Unable to find channel: ${CHANNEL}`);
  }

  jesseId = jesse.id;

  console.log(`Connected as: ${moderatorLogin}`);
  console.log(`Monitoring: #${CHANNEL}`);
  console.log("Tracking:", [...TRACKED_USERS].join(", "));

  connectIRC(userAccessToken, moderatorLogin);

  queueInterval = setInterval(processQueue, 1000);
}

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;
  console.log(`${signal} received. Shutting down...`);

  clearInterval(queueInterval);
  clearTimeout(reconnectTimer);
  clearTimeout(tokenRefreshTimer);

  if (ircSocket && ircSocket.readyState !== WebSocket.CLOSED) {
    ircSocket.close();
  }

  try {
    await closeDB();
  } catch (error) {
    console.error("Database shutdown error:", error.message);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWorker().catch(async (error) => {
  console.error("Worker error:", error.message);
  await closeDB().catch(() => {});
  process.exit(1);
});
