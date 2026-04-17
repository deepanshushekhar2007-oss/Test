import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/telegram";
import { restoreWhatsAppSessions } from "./bot/whatsapp";
import { getMongoDb, closeMongoDb } from "./bot/mongodb";
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

async function initializeOptionalStorage(): Promise<void> {
  if (!process.env["MONGODB_URI"]) {
    logger.warn("MONGODB_URI is not configured; starting Telegram bot without persisted WhatsApp sessions");
    return;
  }

  try {
    await getMongoDb();
    logger.info("MongoDB connected successfully");
    await restoreWhatsAppSessions();
  } catch (err) {
    logger.error({ err }, "MongoDB/session restore failed; continuing with Telegram bot startup");
  }
}

function startKeepAlive(): void {
  const renderUrl = process.env["RENDER_EXTERNAL_URL"];
  if (!renderUrl) return;

  const pingUrl = `${renderUrl}/api/healthz`;
  logger.info({ pingUrl }, "Starting keep-alive pings");
  setInterval(() => {
    const client = pingUrl.startsWith("https") ? https : http;
    client.get(pingUrl, (res) => {
      logger.info({ statusCode: res.statusCode }, "Keep-alive ping complete");
    }).on("error", (err) => {
      logger.error({ err }, "Keep-alive ping failed");
    });
  }, 10 * 60 * 1000);
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutdown signal received");
  await closeMongoDb();
  process.exit(0);
}

async function main(): Promise<void> {
  await initializeOptionalStorage();

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    startKeepAlive();
  });

  startBot();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  logger.error({ err }, "Failed to start");
  process.exit(1);
});
