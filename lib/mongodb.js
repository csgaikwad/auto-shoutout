
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "auto_shoutout";

if (!uri) {
  throw new Error("MONGODB_URI is missing");
}

let client;
let db;
let connectionPromise;

export async function connectDB() {
  if (db) return db;

  if (!connectionPromise) {
    client = new MongoClient(uri);

    connectionPromise = client
      .connect()
      .then(() => {
        db = client.db(dbName);
        console.log(`Connected to MongoDB: ${dbName}`);
        return db;
      })
      .finally(() => {
        connectionPromise = null;
      });
  }

  return connectionPromise;
}

export async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
