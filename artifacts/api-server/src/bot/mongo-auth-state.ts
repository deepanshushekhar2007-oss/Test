import { proto } from "@whiskeysockets/baileys";
import { getCollection } from "./mongodb";
import type { Collection } from "mongodb";

interface AuthKeyDoc {
  _id: string;
  userId: string;
  category: string;
  id: string;
  value: any;
}

let ttlCleanupPromise: Promise<void> | null = null;

function buildKey(userId: string, category: string, id: string): string {
  return `${userId}:${category}:${id}`;
}

const BufferJSON = {
  replacer: (_key: string, value: any) => {
    if (
      value &&
      typeof value === "object" &&
      value.type === "Buffer" &&
      Array.isArray(value.data)
    ) {
      return {
        type: "Buffer",
        data: Buffer.from(value.data).toString("base64"),
      };
    }
    return value;
  },
  reviver: (_key: string, value: any) => {
    if (
      value &&
      typeof value === "object" &&
      value.type === "Buffer" &&
      typeof value.data === "string"
    ) {
      return Buffer.from(value.data, "base64");
    }
    return value;
  },
};

function serialize(value: any): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize(str: string): any {
  return JSON.parse(str, BufferJSON.reviver);
}

async function dropTtlIndexes(collection: Collection): Promise<void> {
  const indexes = await collection.indexes();
  for (const index of indexes) {
    const name = index.name;
    if (!name || name === "_id_") continue;
    if ((index as any).expireAfterSeconds !== undefined) {
      await collection.dropIndex(name);
      console.log(`[MongoDB] Dropped TTL index "${name}" from ${collection.collectionName}`);
    }
  }
}

async function ensureNoSessionTtlIndexes(
  credsCollection: Collection,
  keysCollection: Collection
): Promise<void> {
  if (!ttlCleanupPromise) {
    ttlCleanupPromise = Promise.all([
      dropTtlIndexes(credsCollection),
      dropTtlIndexes(keysCollection),
    ]).then(() => undefined);
  }
  await ttlCleanupPromise;
}

export async function useMongoDBAuthState(userId: string) {
  const credsCollection = await getCollection("wa_creds");
  const keysCollection = await getCollection("wa_keys");

  await ensureNoSessionTtlIndexes(credsCollection, keysCollection);

  await credsCollection.createIndex({ userId: 1 }, { unique: false });
  await keysCollection.createIndex(
    { userId: 1, category: 1, id: 1 },
    { unique: true }
  );

  const readCreds = async () => {
    const doc = await credsCollection.findOne({ _id: userId as any });
    if (doc && doc.creds) {
      return deserialize(doc.creds);
    }
    return null;
  };

  const saveCreds = async (creds: any) => {
    const serialized = serialize(creds);
    await credsCollection.updateOne(
      { _id: userId as any },
      { $set: { userId, creds: serialized, updatedAt: new Date() } },
      { upsert: true }
    );
  };

  const existingCreds = await readCreds();
  const { initAuthCreds } = await import("@whiskeysockets/baileys");
  const creds = existingCreds || initAuthCreds();

  const keys = {
    get: async (type: string, ids: string[]) => {
      const result: Record<string, any> = {};
      const filter = {
        userId,
        category: type,
        id: { $in: ids },
      };
      const docs = await keysCollection.find(filter).toArray();
      for (const doc of docs) {
        let value = deserialize(doc.value);
        if (type === "app-state-sync-key") {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        result[doc.id] = value;
      }
      return result;
    },
    set: async (data: Record<string, Record<string, any>>) => {
      const ops: any[] = [];
      for (const [category, categoryData] of Object.entries(data)) {
        for (const [id, value] of Object.entries(categoryData)) {
          const key = buildKey(userId, category, id);
          if (value) {
            ops.push({
              updateOne: {
                filter: { _id: key },
                update: {
                  $set: {
                    userId,
                    category,
                    id,
                    value: serialize(value),
                    updatedAt: new Date(),
                  },
                },
                upsert: true,
              },
            });
          } else {
            ops.push({
              deleteOne: {
                filter: { _id: key },
              },
            });
          }
        }
      }
      if (ops.length > 0) {
        await keysCollection.bulkWrite(ops);
      }
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () => saveCreds(creds),
  };
}

export async function listStoredWhatsAppSessions(): Promise<Array<{ userId: string; phoneNumber: string }>> {
  const credsCollection = await getCollection("wa_creds");
  const docs = await credsCollection.find({}, { projection: { _id: 1, userId: 1, creds: 1 } }).toArray();
  const sessions: Array<{ userId: string; phoneNumber: string }> = [];

  for (const doc of docs) {
    const userId = String(doc.userId || doc._id || "");
    if (!userId || !doc.creds) continue;

    let phoneNumber = "";
    try {
      const creds = deserialize(doc.creds);
      const rawId = creds?.me?.id || creds?.me?.lid || "";
      const digits = String(rawId).split(":")[0].split("@")[0].replace(/[^0-9]/g, "");
      phoneNumber = digits ? `+${digits}` : "";
      if (!creds?.registered) continue;
    } catch {
      continue;
    }

    sessions.push({ userId, phoneNumber });
  }

  return sessions;
}

export async function clearMongoSession(userId: string): Promise<void> {
  const credsCollection = await getCollection("wa_creds");
  const keysCollection = await getCollection("wa_keys");
  await credsCollection.deleteOne({ _id: userId as any });
  await keysCollection.deleteMany({ userId });
  console.log(`[MongoDB] Cleared session for user: ${userId}`);
}
