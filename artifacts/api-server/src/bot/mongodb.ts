import { MongoClient, Db, Collection } from "mongodb";

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getMongoDb(): Promise<Db> {
  if (db) return db;
  const uri = process.env["MONGODB_URI"];
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is required");
  }
  client = new MongoClient(uri);
  await client.connect();
  const dbName = process.env["MONGODB_DB_NAME"] || "whatsapp_bot";
  db = client.db(dbName);
  console.log(`[MongoDB] Connected to database: ${dbName}`);
  return db;
}

export async function getCollection(name: string): Promise<Collection> {
  const database = await getMongoDb();
  return database.collection(name);
}

export async function closeMongoDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log("[MongoDB] Connection closed");
  }
}
