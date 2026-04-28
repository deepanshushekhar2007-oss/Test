import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/telegram";
import { restoreWhatsAppSessions, getActiveSessionUserIds, sweepIdleSessions } from "./bot/whatsapp";
import { getMongoDb, closeMongoDb } from "./bot/mongodb";
import { cleanupStaleSessions } from "./bot/mongo-auth-state";
import https from "https";
import http from "http";

// ─── Suppress libsignal's verbose console.log spam ──────────────────────────
// The `libsignal-protocol-nodejs` library (used internally by baileys) prints
// every signal session it touches via bare `console.log(obj)` calls. Each one
// triggers util.inspect() on a heavy SessionEntry object containing multiple
// Buffers — causing repeated heap spikes, GC pressure, and gigabytes of log
// output per day. On a 512MB Render host this alone fills RAM in a few hours.
// We patch console.log/info to drop those specific messages while keeping our
// own logs intact.
(() => {
  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const isLibsignalNoise = (args: any[]): boolean => {
    if (args.length === 0) return false;
    const first = args[0];
    if (typeof first !== "string") return false;
    return (
      first.startsWith("Closing session:") ||
      first.startsWith("Removing old closed session:") ||
      first.startsWith("Closing open session in favor") ||
      first.startsWith("Deleting session:") ||
      first.startsWith("Deleting all sessions for") ||
      first.startsWith("Deleting old session record") ||
      first.startsWith("Old session, restoring to current state")
    );
  };
  console.log = (...args: any[]) => {
    if (isLibsignalNoise(args)) return;
    origLog(...args);
  };
  console.info = (...args: any[]) => {
    if (isLibsignalNoise(args)) return;
    origInfo(...args);
  };
})();

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

  // Stale sessions startup pe delete karo
  await runSessionCleanup("STARTUP");

  // Bot aur HTTP server pehle start karo — Telegram updates turant accept ho.
  // WhatsApp sessions background mein restore hongi (har ek 5s stagger se).
  // Iska matlab user button click karega to bot turant respond karega, beshak
  // WhatsApp socket abhi restoring ho. Pehle yeh blocking await tha jiski wajah
  // se 30+ seconds tak bot Telegram updates accept hi nahi karta tha.
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");

    // Render free tier sleep na kare isliye ping
    const renderUrl = process.env["RENDER_EXTERNAL_URL"];
    if (renderUrl) {
      const pingUrl = `${renderUrl}/api/healthz`;
      console.log(`[KEEP-ALIVE] Will ping ${pingUrl} every 10 minutes`);
      setInterval(() => {
        const client = pingUrl.startsWith("https") ? https : http;
        client.get(pingUrl, (res) => {
          console.log(`[KEEP-ALIVE] Ping status: ${res.statusCode}`);
        }).on("error", (err) => {
          console.error(`[KEEP-ALIVE] Ping failed: ${err.message}`);
        });
      }, 10 * 60 * 1000);
    }

    // Har 24 ghante mein auto cleanup chalao
    setInterval(() => {
      runSessionCleanup("DAILY-CLEANUP");
    }, 24 * 60 * 60 * 1000);

    // Har 1 minute mein idle WhatsApp sockets close karo (memory pressure
    // kam karne ke liye). Ye 30 min se idle sessions ko evict karta hai aur
    // RSS jab >380MB ho to LRU se aur close karta hai. User wapas aaye to
    // session lazy-restore ho jayegi.
    setInterval(() => {
      try {
        const { evicted, total } = sweepIdleSessions();
        if (evicted > 0) {
          console.log(`[WA][SWEEP] Evicted ${evicted} idle session(s); ${total} live remaining`);
        }
      } catch (err: any) {
        console.error(`[WA][SWEEP] failed:`, err?.message);
      }
    }, 60 * 1000);

    // Har 5 minute mein GC chalao memory free karne ke liye + heap usage log
    const fmtMb = (n: number) => `${(n / 1024 / 1024).toFixed(0)}MB`;
    setInterval(() => {
      const before = process.memoryUsage();
      if (typeof (global as any).gc === "function") {
        (global as any).gc();
      }
      const after = process.memoryUsage();
      console.log(
        `[MEM] rss=${fmtMb(after.rss)} heap=${fmtMb(after.heapUsed)}/${fmtMb(after.heapTotal)} ` +
        `ext=${fmtMb(after.external)} freed=${fmtMb(Math.max(0, before.heapUsed - after.heapUsed))}`
      );
    }, 5 * 60 * 1000);
  });

  startBot();

  // Fire-and-forget: WhatsApp sessions background mein restore karo. Iska
  // result wait karne ki zaroorat nahi — bot already responsive hai.
  void restoreWhatsAppSessions().catch((err: any) => {
    console.error(`[WA][RESTORE] background restore failed:`, err?.message);
  });
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
