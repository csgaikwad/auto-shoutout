import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "auto_shoutout";

if (!uri) {
  throw new Error("MONGODB_URI is missing");
}

const client = new MongoClient(uri);

let db;

export async function connectDB() {
  if (db) return db;

  await client.connect();

  db = client.db(dbName);

  console.log(`Connected to MongoDB: ${dbName}`);

  return db;
}