
import WebSocket from "ws";
import { getAppAccessToken, getUser } from "./lib/twitch.js";
import { sendShoutout } from "./lib/shoutout.js";
import { loadWorkerState, saveWorkerState } from "./lib/state.js";

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

let refreshToken = process.env.TWITCH_USER_REFRESH_TOKEN;

let queue = [];
let pendingUsers = new Set();
let shoutedUsers = {};
let nextShoutoutAt = 0;

let processing = false;
const userIds = new Map();

async function persistState() {
  await saveWorkerState({
    queue,
    pendingUsers: [...pendingUsers],
    shoutedUsers,
    nextShoutoutAt,
  });
}

async function getAccessToken() {
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
    throw new Error(data.message || "Token refresh failed");
  }

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    refreshToken = data.refresh_token;
    console.log("Refresh token rotated. Save the new token securely.");
    console.log("NEW_TWITCH_REFRESH_TOKEN:", refreshToken);
  }

  return data.access_token;
}

async function processQueue(accessToken, jesseId, moderatorId, appToken) {
  if (processing || queue.length === 0 || Date.now() < nextShoutoutAt) {
    return;
  }

  processing = true;

  const username = queue[0];

  try {
    let targetId = userIds.get(username);

    if (!targetId) {
      const user = await getUser(username, appToken);
      targetId = user.id;
      userIds.set(username, targetId);
    }

    await sendShoutout({
      accessToken,
      fromBroadcasterId: jesseId,
      toBroadcasterId: targetId,
      moderatorId,
    });

    shoutedUsers[username] = Date.now();
    queue.shift();
    pendingUsers.delete(username);

    nextShoutoutAt = Date.now() + SHOUTOUT_COOLDOWN;

    await persistState();

    console.log(`Shoutout successful: ${username}`);
  } catch (error) {
    console.error(`Shoutout failed for ${username}:`, error.message);

    nextShoutoutAt =
      Date.now() +
      (error.status === 429 ? SHOUTOUT_COOLDOWN : RETRY_DELAY);

    await persistState();
  } finally {
    processing = false;
  }
}

async function startWorker() {
  if (!CHANNEL || TRACKED_USERS.size === 0) {
    throw new Error("Configure JESSE_USERNAME and TRACKED_USERS");
  }

  // Restore saved state from MongoDB.
  const savedState = await loadWorkerState();

  queue = savedState.queue;
  pendingUsers = new Set(savedState.pendingUsers);
  shoutedUsers = savedState.shoutedUsers;
  nextShoutoutAt = savedState.nextShoutoutAt;

  // Remove expired shoutout history.
  const now = Date.now();

  for (const [username, timestamp] of Object.entries(shoutedUsers)) {
    if (now - timestamp >= REPEAT_PREVENTION) {
      delete shoutedUsers[username];
    }
  }

  // Remove invalid and duplicate queue entries.
  queue = [...new Set(queue)].filter(
    (username) =>
      TRACKED_USERS.has(username) &&
      pendingUsers.has(username) &&
      !(
        shoutedUsers[username] &&
        now - shoutedUsers[username] < REPEAT_PREVENTION
      ),
  );

  pendingUsers = new Set(queue);

  await persistState();

  console.log(`Restored ${queue.length} queued shoutouts.`);

  const accessToken = await getAccessToken();

  const validateResponse = await fetch(
    "https://id.twitch.tv/oauth2/validate",
    {
      headers: {
        Authorization: `OAuth ${accessToken}`,
      },
    },
  );

  const moderator = await validateResponse.json();

  if (!validateResponse.ok) {
    throw new Error("Unable to validate moderator account");
  }

  const appToken = await getAppAccessToken();
  const jesse = await getUser(CHANNEL, appToken);

  console.log(`Connected as: ${moderator.login}`);
  console.log(`Monitoring: #${CHANNEL}`);
  console.log("Tracking:", [...TRACKED_USERS].join(", "));

  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

  ws.on("open", () => {
    ws.send(`PASS oauth:${accessToken}`);
    ws.send(`NICK ${moderator.login}`);
    ws.send("CAP REQ :twitch.tv/membership");
    ws.send(`JOIN #${CHANNEL}`);

    console.log("Connected to Twitch IRC");
  });

  ws.on("message", async (data) => {
    const messages = data.toString().split("\r\n");

    for (const message of messages) {
      if (!message) continue;

      if (message.startsWith("PING")) {
        ws.send("PONG :tmi.twitch.tv");
        continue;
      }

      const joinMatch = message.match(/^:([^!]+)![^ ]+ JOIN #/i);

      if (!joinMatch) continue;

      const username = joinMatch[1].toLowerCase();

      if (!TRACKED_USERS.has(username)) continue;

      const lastShoutout = shoutedUsers[username];

      if (
        lastShoutout &&
        Date.now() - lastShoutout < REPEAT_PREVENTION
      ) {
        console.log(`${username} already received a shoutout recently.`);
        continue;
      }

      if (pendingUsers.has(username)) continue;

      pendingUsers.add(username);
      queue.push(username);

      await persistState();

      console.log(`${username} added to queue.`);
    }
  });

  ws.on("error", (error) => {
    console.error("IRC error:", error.message);
  });

  ws.on("close", () => {
    console.log("IRC connection closed");
  });

  setInterval(() => {
    processQueue(accessToken, jesse.id, moderator.user_id, appToken);
  }, 1000);
}

startWorker().catch((error) => {
  console.error("Worker error:", error.message);
  process.exit(1);
});
