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
  let indexes;
  try {
    indexes = await collection.indexes();
  } catch (err: any) {
    const msg = String(err?.message || "");
    const code = err?.code;
    if (code === 26 || msg.includes("ns does not exist") || msg.includes("NamespaceNotFound")) {
      return;
    }
    throw err;
  }
  for (const index of indexes) {
    const name = index.name;
    if (!name || name === "_id_") continue;
    if ((index as any).expireAfterSeconds !== undefined) {
      try {
        await collection.dropIndex(name);
        console.log(`[MongoDB] Dropped TTL index "${name}" from ${collection.collectionName}`);
      } catch (err: any) {
        const msg = String(err?.message || "");
        const code = err?.code;
        if (code === 26 || code === 27 || msg.includes("ns does not exist") || msg.includes("index not found")) {
          continue;
        }
        throw err;
      }
    }
  }
}

async function ensureCollectionExists(db: any, name: string): Promise<void> {
  try {
    const existing = await db.listCollections({ name }).toArray();
    if (existing.length === 0) {
      await db.createCollection(name);
      console.log(`[MongoDB] Created collection: ${name}`);
    }
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (msg.includes("already exists") || err?.code === 48) {
      return;
    }
    throw err;
  }
}

async function safeCreateIndex(
  collection: Collection,
  spec: Record<string, 1 | -1>,
  options: any = {}
): Promise<void> {
  try {
    await collection.createIndex(spec, options);
  } catch (err: any) {
    const msg = String(err?.message || "");
    const code = err?.code;
    if (code === 26 || msg.includes("ns does not exist") || msg.includes("NamespaceNotFound")) {
      return;
    }
    throw err;
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
  const { getMongoDb } = await import("./mongodb");
  const db = await getMongoDb();
  await ensureCollectionExists(db, "wa_creds");
  await ensureCollectionExists(db, "wa_keys");

  const credsCollection = await getCollection("wa_creds");
  const keysCollection = await getCollection("wa_keys");

  await ensureNoSessionTtlIndexes(credsCollection, keysCollection);

  await safeCreateIndex(credsCollection, { userId: 1 }, { unique: false });
  await safeCreateIndex(
    keysCollection,
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

/**
 * Auto-cleanup: Delete stale sessions from MongoDB.
 *
 * Rules:
 * 1. Sessions not updated in `staleAfterDays` days (default 7) are deleted.
 * 2. Sessions that were NEVER fully paired (registered=false) and older than 1 day are deleted.
 * 3. Orphaned wa_keys (no matching wa_creds) are also cleaned up.
 * 4. Sessions in `activeUserIds` are NEVER deleted even if stale.
 *
 * Returns a summary of what was deleted.
 */
export async function cleanupStaleSessions(
  activeUserIds: Set<string> = new Set(),
  staleAfterDays = 7
): Promise<{ deletedSessions: number; deletedKeys: number; deletedUnpaired: number }> {
  const credsCollection = await getCollection("wa_creds");
  const keysCollection = await getCollection("wa_keys");

  const now = new Date();
  const staleDate = new Date(now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

  let deletedSessions = 0;
  let deletedKeys = 0;
  let deletedUnpaired = 0;

  // Fetch all creds documents
  const allDocs = await credsCollection
    .find({}, { projection: { _id: 1, userId: 1, creds: 1, updatedAt: 1 } })
    .toArray();

  const toDelete: string[] = [];

  for (const doc of allDocs) {
    const userId = String(doc.userId || doc._id || "");
    if (!userId) continue;

    // Never delete currently active sessions
    if (activeUserIds.has(userId)) continue;

    const updatedAt: Date | undefined = doc.updatedAt instanceof Date
      ? doc.updatedAt
      : doc.updatedAt
        ? new Date(doc.updatedAt)
        : undefined;

    let isRegistered = false;
    try {
      const creds = deserialize(doc.creds);
      isRegistered = creds?.registered === true;
    } catch {
      // Corrupt doc — mark for deletion
      toDelete.push(userId);
      continue;
    }

    // Rule 1: Registered session not updated in staleAfterDays days
    if (isRegistered && updatedAt && updatedAt < staleDate) {
      console.log(`[CLEANUP] Stale session userId=${userId} lastSeen=${updatedAt.toISOString()}`);
      toDelete.push(userId);
      continue;
    }

    // Rule 2: Never registered (incomplete pairing) older than 1 day
    if (!isRegistered && updatedAt && updatedAt < oneDayAgo) {
      console.log(`[CLEANUP] Unpaired session userId=${userId} createdAt=${updatedAt.toISOString()}`);
      toDelete.push(userId);
      deletedUnpaired++;
      continue;
    }

    // Rule 3: No updatedAt field and session is very old (fallback)
    if (!updatedAt && !isRegistered) {
      console.log(`[CLEANUP] Unknown-age unpaired session userId=${userId}`);
      toDelete.push(userId);
      deletedUnpaired++;
    }
  }

  // Delete stale creds
  for (const userId of toDelete) {
    await credsCollection.deleteOne({ _id: userId as any });
    const keysResult = await keysCollection.deleteMany({ userId });
    deletedKeys += keysResult.deletedCount ?? 0;
    deletedSessions++;
  }

  // Rule 4: Clean up orphaned wa_keys (userId not in any wa_creds)
  const remainingUserIds = allDocs
    .map((d) => String(d.userId || d._id || ""))
    .filter((id) => id && !toDelete.includes(id));

  let orphanResult;
  if (remainingUserIds.length > 0) {
    // Delete keys whose userId is not in remaining sessions
    orphanResult = await keysCollection.deleteMany({
      userId: { $nin: remainingUserIds },
    });
  } else {
    // No sessions remain at all — delete ALL keys safely
    orphanResult = await keysCollection.deleteMany({});
  }
  const orphanCount = orphanResult.deletedCount ?? 0;
  if (orphanCount > 0) {
    console.log(`[CLEANUP] Deleted ${orphanCount} orphaned wa_keys`);
    deletedKeys += orphanCount;
  }

  console.log(
    `[CLEANUP] Done — deleted ${deletedSessions} stale sessions (${deletedUnpaired} unpaired), ${deletedKeys} keys`
  );

  return { deletedSessions, deletedKeys, deletedUnpaired };
}

/**
 * Get session info for all stored sessions — used by admin Telegram command.
 */
export async function getSessionStats(): Promise<Array<{
  userId: string;
  phoneNumber: string;
  registered: boolean;
  lastSeen: string;
}>> {
  const credsCollection = await getCollection("wa_creds");
  const docs = await credsCollection
    .find({}, { projection: { _id: 1, userId: 1, creds: 1, updatedAt: 1 } })
    .toArray();

  const result = [];
  for (const doc of docs) {
    const userId = String(doc.userId || doc._id || "");
    if (!userId) continue;

    let phoneNumber = "";
    let registered = false;
    try {
      const creds = deserialize(doc.creds);
      const rawId = creds?.me?.id || creds?.me?.lid || "";
      const digits = String(rawId).split(":")[0].split("@")[0].replace(/[^0-9]/g, "");
      phoneNumber = digits ? `+${digits}` : "unknown";
      registered = creds?.registered === true;
    } catch {
      phoneNumber = "corrupt";
    }

    const updatedAt = doc.updatedAt
      ? new Date(doc.updatedAt).toLocaleDateString("en-IN", {
          day: "2-digit", month: "short", year: "numeric",
        })
      : "unknown";

    result.push({ userId, phoneNumber, registered, lastSeen: updatedAt });
  }

  return result;
}
