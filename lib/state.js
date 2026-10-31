
import { connectDB } from "./mongodb.js";

const DEFAULT_STATE = {
  queue: [],
  pendingUsers: [],
  shoutedUsers: {},
  nextShoutoutAt: 0,
};

export async function loadWorkerState() {
  const db = await connectDB();
  const collection = db.collection("worker_state");

  const document = await collection.findOne({
    _id: "main",
  });

  if (!document) {
    await collection.insertOne({
      _id: "main",
      ...DEFAULT_STATE,
      updatedAt: new Date(),
    });

    return { ...DEFAULT_STATE };
  }

  return {
    ...DEFAULT_STATE,
    queue: document.queue || [],
    pendingUsers: document.pendingUsers || [],
    shoutedUsers: document.shoutedUsers || {},
    nextShoutoutAt: document.nextShoutoutAt || 0,
  };
}

export async function saveWorkerState(state) {
  const db = await connectDB();
  const collection = db.collection("worker_state");

  await collection.updateOne(
    { _id: "main" },
    {
      $set: {
        queue: state.queue,
        pendingUsers: state.pendingUsers,
        shoutedUsers: state.shoutedUsers,
        nextShoutoutAt: state.nextShoutoutAt,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}
