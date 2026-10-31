import { connectDB } from "./mongodb.js";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const STATE_ID = "main";

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

  const result = await db.collection("worker_state").updateOne(
    { _id: STATE_ID },
    [
      {
        $set: {
          queue: {
            $let: {
              vars: {
                q: { $ifNull: ["$queue", []] },
                p: { $ifNull: ["$pendingUsers", []] },
              },
              in: {
                $cond: [
                  { $in: [username, "$$p"] },
                  "$$q",
                  { $concatArrays: ["$$q", [username]] },
                ],
              },
            },
          },
          pendingUsers: {
            $let: {
              vars: {
                p: { $ifNull: ["$pendingUsers", []] },
              },
              in: {
                $cond: [
                  { $in: [username, "$$p"] },
                  "$$p",
                  { $concatArrays: ["$$p", [username]] },
                ],
              },
            },
          },
        },
      },
    ],
    { upsert: true },
  );

  return result.modifiedCount > 0 || result.upsertedCount > 0;
}

export async function removeQueuedUser(username) {
  const db = await connectDB();

  await db.collection("worker_state").updateOne({ _id: STATE_ID }, [
    {
      $set: {
        queue: {
          $filter: {
            input: { $ifNull: ["$queue", []] },
            as: "user",
            cond: { $ne: ["$$user", username] },
          },
        },
        pendingUsers: {
          $filter: {
            input: { $ifNull: ["$pendingUsers", []] },
            as: "user",
            cond: { $ne: ["$$user", username] },
          },
        },
      },
    },
  ]);
}

export async function recordShoutout(username, timestamp, nextShoutoutAt) {
  const db = await connectDB();

  await db.collection("worker_state").updateOne(
    { _id: STATE_ID },
    [
      {
        $set: {
          queue: {
            $filter: {
              input: { $ifNull: ["$queue", []] },
              as: "user",
              cond: { $ne: ["$$user", username] },
            },
          },
          pendingUsers: {
            $filter: {
              input: { $ifNull: ["$pendingUsers", []] },
              as: "user",
              cond: { $ne: ["$$user", username] },
            },
          },
          shoutedUsers: {
            $mergeObjects: [
              { $ifNull: ["$shoutedUsers", {}] },
              { [username]: timestamp },
            ],
          },
          nextShoutoutAt: {
            $max: [{ $ifNull: ["$nextShoutoutAt", 0] }, nextShoutoutAt],
          },
        },
      },
    ],
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

function getEncryptionKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY;

  if (!/^[0-9a-f]{64}$/i.test(key || "")) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  }

  return Buffer.from(key, "hex");
}

export async function loadRefreshToken() {
  const db = await connectDB();

  const document = await db.collection("worker_secrets").findOne({
    _id: "twitch_refresh_token",
  });

  if (!document) return null;

  // Migrate an existing plaintext token automatically.
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
}

export async function isEventProcessed(messageId) {
  const db = await connectDB();

  return Boolean(
    await db.collection("eventsub_messages").findOne({
      _id: messageId,
    }),
  );
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
