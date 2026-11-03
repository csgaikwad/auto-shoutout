import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { connectDB } from "./mongodb.js";

const STATE_ID = "main";

function getEncryptionKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY;

  if (!/^[0-9a-f]{64}$/i.test(key || "")) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  }

  return Buffer.from(key, "hex");
}

export async function loadWorkerState() {
  const db = await connectDB();

  const state = await db.collection("worker_state").findOne({
    _id: STATE_ID,
  });

  return {
    queue: state?.queue || [],
    pendingUsers: state?.pendingUsers || [],
    shoutedUsers: state?.shoutedUsers || {},
    nextShoutoutAt: state?.nextShoutoutAt || 0,
  };
}

export async function enqueueUser(username) {
  const db = await connectDB();

  await db.collection("worker_state").updateOne(
    { _id: STATE_ID },
    [
      {
        $set: {
          queue: {
            $let: {
              vars: {
                queue: { $ifNull: ["$queue", []] },
                pending: { $ifNull: ["$pendingUsers", []] },
              },
              in: {
                $cond: [
                  { $in: [username, "$$pending"] },
                  "$$queue",
                  { $concatArrays: ["$$queue", [username]] },
                ],
              },
            },
          },
          pendingUsers: {
            $setUnion: [{ $ifNull: ["$pendingUsers", []] }, [username]],
          },
        },
      },
    ],
    { upsert: true },
  );
}

export async function removeQueuedUser(username) {
  const db = await connectDB();

  await db.collection("worker_state").updateOne(
    { _id: STATE_ID },
    {
      $pull: {
        queue: username,
        pendingUsers: username,
      },
    },
  );
}

export async function recordShoutout(username, timestamp, nextShoutoutAt) {
  const db = await connectDB();

  await db.collection("worker_state").updateOne(
    { _id: STATE_ID },
    {
      $pull: {
        queue: username,
        pendingUsers: username,
      },
      $set: {
        [`shoutedUsers.${username}`]: timestamp,
      },
      $max: {
        nextShoutoutAt,
      },
    },
    { upsert: true },
  );
}

export async function updateNextShoutoutAt(timestamp) {
  const db = await connectDB();

  await db
    .collection("worker_state")
    .updateOne(
      { _id: STATE_ID },
      { $max: { nextShoutoutAt: timestamp } },
      { upsert: true },
    );
}

export async function loadRefreshToken() {
  const db = await connectDB();

  const document = await db.collection("worker_secrets").findOne({
    _id: "twitch_refresh_token",
  });

  if (!document) return null;

  // Migrate an existing plaintext token.
  if (document.value) {
    const token = document.value;
    await saveRefreshToken(token);
    return token;
  }

  if (!document.encryptedValue) return null;

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(document.iv, "hex"),
  );

  decipher.setAuthTag(Buffer.from(document.authTag, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(document.encryptedValue, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

export async function saveRefreshToken(token) {
  const db = await connectDB();
  const iv = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);

  await db.collection("worker_secrets").updateOne(
    { _id: "twitch_refresh_token" },
    {
      $set: {
        encryptedValue: encrypted.toString("hex"),
        iv: iv.toString("hex"),
        authTag: cipher.getAuthTag().toString("hex"),
        updatedAt: new Date(),
      },
      $unset: {
        value: "",
      },
    },
    { upsert: true },
  );

  // Invalidate the cached access token.
  await db.collection("worker_secrets").deleteOne({
    _id: "twitch_access_token",
  });
}

export async function markEventProcessed(messageId) {
  const db = await connectDB();
  const collection = db.collection("eventsub_messages");

  await collection.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 604800 },
  );

  try {
    await collection.insertOne({
      _id: messageId,
      createdAt: new Date(),
    });

    return true;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

export async function acquireCronLock(owner, lockUntil) {
  const db = await connectDB();
  const collection = db.collection("cron_locks");

  try {
    const result = await collection.updateOne(
      {
        _id: "queue_processor",
        $or: [
          { lockUntil: { $lte: new Date() } },
          { lockUntil: { $exists: false } },
        ],
      },
      {
        $set: {
          owner,
          lockUntil: new Date(lockUntil),
        },
      },
      { upsert: true },
    );

    return result.modifiedCount === 1 || result.upsertedCount === 1;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

export async function releaseCronLock(owner) {
  const db = await connectDB();

  await db.collection("cron_locks").deleteOne({
    _id: "queue_processor",
    owner,
  });
}

export async function loadCachedModeratorAccess() {
  const db = await connectDB();

  const document = await db.collection("worker_secrets").findOne({
    _id: "twitch_access_token",
  });

  if (!document || document.expiresAt <= Date.now() + 5 * 60 * 1000) {
    return null;
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(document.iv, "hex"),
  );

  decipher.setAuthTag(Buffer.from(document.authTag, "hex"));

  const accessToken = Buffer.concat([
    decipher.update(Buffer.from(document.encryptedValue, "hex")),
    decipher.final(),
  ]).toString("utf8");

  return {
    accessToken,
    moderator: document.moderator,
  };
}

export async function saveCachedModeratorAccess(
  accessToken,
  expiresIn,
  moderator,
) {
  const db = await connectDB();
  const iv = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(accessToken, "utf8"),
    cipher.final(),
  ]);

  await db.collection("worker_secrets").updateOne(
    { _id: "twitch_access_token" },
    {
      $set: {
        encryptedValue: encrypted.toString("hex"),
        iv: iv.toString("hex"),
        authTag: cipher.getAuthTag().toString("hex"),
        expiresAt: Date.now() + expiresIn * 1000,
        moderator,
      },
    },
    { upsert: true },
  );
}


export async function resetShoutedUsersDaily() {
  const db = await connectDB();

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
  }).format(new Date());

  await db.collection("worker_state").updateOne(
    {
      _id: "main",
      dailyResetDate: { $ne: today },
    },
    {
      $set: {
        shoutedUsers: {},
        dailyResetDate: today,
      },
    },
  );
}