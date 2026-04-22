import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/telegram";
import { restoreWhatsAppSessions, getActiveSessionUserIds } from "./bot/whatsapp";
import { getMongoDb, closeMongoDb } from "./bot/mongodb";
import { cleanupStaleSessions } from "./bot/mongo-auth-state";
import https from "https";
import http from "http";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Kitne din baad inactive session delete karna hai (default: 7 din)
const STALE_SESSION_DAYS = Number(process.env["STALE_SESSION_DAYS"] || "7");

async function runSessionCleanup(label: string): Promise<void> {
  try {
    const active = getActiveSessionUserIds();
    const result = await cleanupStaleSessions(active, STALE_SESSION_DAYS);
    if (result.deletedSessions > 0 || result.deletedKeys > 0) {
      console.log(
        `[${label}] Session cleanup: ${result.deletedSessions} stale sessions deleted ` +
        `(${result.deletedUnpaired} unpaired), ${result.deletedKeys} keys freed from MongoDB`
      );
    } else {
      console.log(`[${label}] Session cleanup: no stale sessions found`);
    }
  } catch (err: any) {
    console.error(`[${label}] Session cleanup failed:`, err?.message);
  }
}

async function main() {
  await getMongoDb();
  console.log("[INIT] MongoDB connected successfully");

  // Stale sessions startup pe delete karo, uske baad active sessions restore karo
  await runSessionCleanup("STARTUP");

  await restoreWhatsAppSessions();

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");

    // Render free tier sleep na kare isliye ping
    const renderUrl = process.env["RENDER_EXTERNAL_URL"] || process.env["WEBHOOK_URL"];
    if (renderUrl) {
      const pingUrl = `${renderUrl.replace(/\/$/, "")}/api/healthz`;
      console.log(`[KEEP-ALIVE] Will ping ${pingUrl} every 5 minutes`);
      setInterval(() => {
        const client = pingUrl.startsWith("https") ? https : http;
        client.get(pingUrl, (res) => {
          console.log(`[KEEP-ALIVE] Ping status: ${res.statusCode}`);
        }).on("error", (err) => {
          console.error(`[KEEP-ALIVE] Ping failed: ${err.message}`);
        });
      }, 5 * 60 * 1000);
    }

    // Har 24 ghante mein auto cleanup chalao
    setInterval(() => {
      runSessionCleanup("DAILY-CLEANUP");
    }, 24 * 60 * 60 * 1000);

    // Har 5 minute mein GC chalao memory free karne ke liye
    setInterval(() => {
      if (typeof (global as any).gc === "function") {
        (global as any).gc();
        console.log("[GC] Manual garbage collection done");
      }
    }, 5 * 60 * 1000);
  });

  startBot();
}

process.on("uncaughtException", (err: any) => {
  const msg = err?.message || "";
  if (
    msg.includes("Unsupported state or unable to authenticate data") ||
    msg.includes("aesDecryptGCM") ||
    msg.includes("noise-handler") ||
    msg.includes("decodeFrame")
  ) {
    console.warn("[WA] Caught WhatsApp crypto error (corrupt session), ignoring:", msg);
    return;
  }
  console.error("[UNCAUGHT EXCEPTION]", err);
});

process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message || String(reason);
  if (
    msg.includes("Unsupported state or unable to authenticate data") ||
    msg.includes("aesDecryptGCM")
  ) {
    console.warn("[WA] Caught unhandled WA crypto rejection, ignoring:", msg);
    return;
  }
  console.error("[UNHANDLED REJECTION]", reason);
});

process.on("SIGTERM", async () => {
  console.log("[SHUTDOWN] SIGTERM received, closing MongoDB...");
  await closeMongoDb();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[SHUTDOWN] SIGINT received, closing MongoDB...");
  await closeMongoDb();
  process.exit(0);
});

main().catch((err) => {
  console.error("[INIT] Failed to start:", err);
  process.exit(1);
});
