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

async function main() {
  await getMongoDb();
  console.log("[INIT] MongoDB connected successfully");
  await restoreWhatsAppSessions();

  app.listen(port, async (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");

    // Register Telegram webhook AFTER server is listening so the URL is reachable.
    await startBot();

    // Keep-alive ping prevents Render free tier from spinning down due to inactivity.
    const renderUrl = process.env["RENDER_EXTERNAL_URL"];
    if (renderUrl) {
      const pingUrl = `${renderUrl}/api/healthz`;
      console.log(`[KEEP-ALIVE] Will ping ${pingUrl} every 5 minutes`);
      setInterval(() => {
        const client = pingUrl.startsWith("https") ? https : http;
        client.get(pingUrl, (res) => {
          console.log(`[KEEP-ALIVE] Ping status: ${res.statusCode}`);
          res.resume();
        }).on("error", (err) => {
          console.error(`[KEEP-ALIVE] Ping failed: ${err.message}`);
        });
      }, 5 * 60 * 1000);
    }
  });
}

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
