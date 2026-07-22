import TelegramBot from "node-telegram-bot-api";
import { logger } from "./lib/logger";

const TOKEN = process.env["TELEGRAM_BOT_TOKEN"];

if (!TOKEN) {
  logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot will not start");
}

interface QREntry {
  qrNumber: string;
  paymentUrl: string | null;
}

function parseQREntries(
  text: string,
  entities: TelegramBot.MessageEntity[],
): QREntry[] {
  // Flexible pattern: matches "QR #67", "QR67", "QR 67", "QR#67" etc.
  const qrPattern = /QR\s*#?\s*(\d+)/gi;
  const qrMatches: { number: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = qrPattern.exec(text)) !== null) {
    qrMatches.push({ number: match[1]!, index: match.index });
  }

  if (qrMatches.length === 0) return [];

  const linkEntities = (entities || [])
    .filter((e) => e.type === "text_link" && e.url)
    .sort((a, b) => a.offset - b.offset);

  return qrMatches.map((qr, i) => ({
    qrNumber: qr.number,
    paymentUrl: linkEntities[i]?.url ?? null,
  }));
}

type PaymentStatus = "verified" | "expired" | "unknown";

async function fetchStripePayload(
  url: string,
): Promise<{ clientSecret: string; pubKey: string } | null> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Encoding": "identity",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });

  const html = await resp.text();
  const match = html.match(/id="payload"\s+data-message="([^"]+)"/);
  if (!match) {
    logger.warn({ url }, "No Stripe payload meta tag found");
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8"));
  } catch {
    logger.warn({ url }, "Failed to decode Stripe payload JSON");
    return null;
  }

  const clientSecret = payload["client_secret"] as string | undefined;
  const pubKey       = payload["publishable_key"] as string | undefined;
  if (!clientSecret || !pubKey) return null;

  return { clientSecret, pubKey };
}

async function checkPaymentStatus(url: string): Promise<PaymentStatus> {
  try {
    const payload = await fetchStripePayload(url);
    if (!payload) return "unknown";

    const { clientSecret, pubKey } = payload;
    const intentId   = clientSecret.split("_secret_")[0]!;
    const intentType = intentId.startsWith("seti_") ? "setup_intents" : "payment_intents";

    const apiUrl    = `https://api.stripe.com/v1/${intentType}/${intentId}?client_secret=${encodeURIComponent(clientSecret)}`;
    const authHeader = "Basic " + Buffer.from(pubKey + ":").toString("base64");

    const apiResp = await fetch(apiUrl, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(12000),
    });

    const data   = (await apiResp.json()) as Record<string, unknown>;
    const status = data["status"] as string | undefined;
    logger.info({ url, intentId, intentType, status }, "Stripe status");

    if (status === "succeeded" || status === "requires_capture") return "verified";
    if (status === "canceled"  || status === "requires_payment_method") return "expired";
    return "unknown";
  } catch (err) {
    logger.error({ err, url }, "Error checking Stripe status");
    return "unknown";
  }
}

// Runs at most `limit` tasks simultaneously
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type ResultStatus = PaymentStatus | "nolink";
interface QRResult { qrNumber: string; status: ResultStatus; }

// ── Per-chat session ──────────────────────────────────────────────────────────
interface ChatSession {
  entries: QREntry[];
  donePending: boolean;     // true while /done is counting down
  lastMessageAt: number;    // timestamp of last QR message received
  ackTimer: NodeJS.Timeout | null;
  pendingAckCount: number;
}

const sessions = new Map<number, ChatSession>();

function getSession(chatId: number): ChatSession {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      entries: [],
      donePending: false,
      lastMessageAt: Date.now(),
      ackTimer: null,
      pendingAckCount: 0,
    });
  }
  return sessions.get(chatId)!;
}

function buildProgressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${pct}%`;
}

function buildReport(results: QRResult[]): string {
  const verified = results.filter((r) => r.status === "verified");
  const expired  = results.filter((r) => r.status === "expired");
  const unknown  = results.filter((r) => r.status === "unknown");
  const noLink   = results.filter((r) => r.status === "nolink");

  const lines: string[] = [];
  lines.push(`🧾 *UPI QR Payment Report*`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (verified.length > 0) {
    lines.push(`\n✅ *VERIFIED — ${verified.length} QR(s)*`);
    verified.forEach((r) => lines.push(`  ▸ QR #${r.qrNumber}`));
  }
  if (expired.length > 0) {
    lines.push(`\n❌ *EXPIRED — ${expired.length} QR(s)*`);
    expired.forEach((r) => lines.push(`  ▸ QR #${r.qrNumber}`));
  }
  if (unknown.length > 0) {
    lines.push(`\n❓ *PENDING / UNKNOWN — ${unknown.length} QR(s)*`);
    unknown.forEach((r) => lines.push(`  ▸ QR #${r.qrNumber}`));
  }
  if (noLink.length > 0) {
    lines.push(`\n⚠️ *NO LINK FOUND — ${noLink.length} QR(s)*`);
    noLink.forEach((r) => lines.push(`  ▸ QR #${r.qrNumber}`));
  }

  lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(
    `📊 *Summary*\n` +
    `  Total Checked : ${results.length}\n` +
    `  ✅ Verified    : ${verified.length}\n` +
    `  ❌ Expired     : ${expired.length}\n` +
    `  ❓ Pending     : ${unknown.length}\n` +
    `  ⚠️ No Link     : ${noLink.length}`,
  );
  return lines.join("\n");
}

const START_MESSAGE = `
🤖 *UPI QR Checker Bot*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Welcome\\! This bot verifies UPI QR payment links via Stripe's API\\.

*📌 What this bot does:*
• Collects UPI QR payment entries you forward
• Checks each payment link via Stripe API
• Reports ✅ Verified, ❌ Expired, ❓ Pending, or ⚠️ No Link

*🚀 How to use:*
1\\. Forward messages containing *QR \\#number* entries with payment links
2\\. Send as many as you need \\(100\\+ supported\\)
3\\. Type /done — bot waits for all messages to arrive, then checks them all
4\\. Type /reset to clear the list and start over

*📋 Commands:*
/start — Show this help message
/status — Show how many QRs are in the queue
/done — Check all collected QR entries
/reset — Clear the current list and start over

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Owner:* @SPIDYWS
`.trim();

// After /done: keep collecting until this many ms pass with NO new messages
const IDLE_TIMEOUT_MS   = 3000;
// Hard cap: never wait longer than this regardless
const HARD_CAP_MS       = 20000;
// Poll interval for the sliding-window loop
const POLL_MS           = 300;
// Max simultaneous Stripe requests
const CONCURRENCY_LIMIT = 10;
// Debounce delay before sending a single ack
const ACK_DEBOUNCE_MS   = 2000;

export function startBot(): void {
  if (!TOKEN) return;

  const bot = new TelegramBot(TOKEN, {
    polling: {
      interval: 100,          // start next poll 100 ms after previous completes
      autoStart: true,
      params: {
        limit: 100,           // fetch up to 100 updates at once
        timeout: 10,          // long-poll: server holds connection for 10 s
        allowed_updates: JSON.stringify(["message"]),
      },
    },
  });
  logger.info("Telegram bot started with polling");

  // ── /start ──────────────────────────────────────────────────────────────────
  bot.onText(/^\/start$/i, async (msg) => {
    await bot.sendMessage(msg.chat.id, START_MESSAGE, { parse_mode: "MarkdownV2" });
  });

  // ── /status ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/status$/i, async (msg) => {
    const chatId  = msg.chat.id;
    const session = getSession(chatId);
    const count   = session.entries.length;
    if (count === 0) {
      await bot.sendMessage(chatId,
        `📭 *Queue is empty*\n\nNo QR entries collected yet\\.`,
        { parse_mode: "MarkdownV2" });
    } else {
      await bot.sendMessage(chatId,
        `📬 *Queue Status: ${count} QR${count === 1 ? "" : "s"}*\n\nType /done to verify them now\\.`,
        { parse_mode: "MarkdownV2" });
    }
  });

  // ── /reset ──────────────────────────────────────────────────────────────────
  bot.onText(/^\/reset$/i, async (msg) => {
    const chatId  = msg.chat.id;
    const session = getSession(chatId);
    if (session.ackTimer) clearTimeout(session.ackTimer);
    sessions.delete(chatId);
    await bot.sendMessage(chatId,
      `🔄 *Session Reset\\!*\n\nList cleared\\. Send new QR messages and type /done when ready\\.`,
      { parse_mode: "MarkdownV2" });
  });

  // ── /done ───────────────────────────────────────────────────────────────────
  bot.onText(/^\/done$/i, async (msg) => {
    const chatId  = msg.chat.id;
    const session = getSession(chatId);

    // Ignore if already processing
    if (session.donePending) {
      await bot.sendMessage(chatId,
        `⏳ Already collecting\\! Please wait for the current run to finish\\.`,
        { parse_mode: "MarkdownV2" });
      return;
    }

    // Cancel any pending ack timer
    if (session.ackTimer) { clearTimeout(session.ackTimer); session.ackTimer = null; }

    // Mark as pending immediately — message handler still adds entries silently
    session.donePending  = true;
    session.lastMessageAt = Date.now();

    // ── Phase 1: Sliding-window collection ────────────────────────────────────
    // We keep waiting until IDLE_TIMEOUT_MS passes with NO new QR messages,
    // OR HARD_CAP_MS total has elapsed — whichever comes first.
    // This guarantees we capture every forwarded message even if the user
    // pressed /done before all 100 arrived on our polling side.

    const collectMsg = await bot.sendMessage(chatId,
      `📥 *Collecting messages\\.\\.\\.*\n\n` +
      `Waiting for all QRs to arrive\\. Queue: *${session.entries.length}*`,
      { parse_mode: "MarkdownV2" });

    const hardDeadline = Date.now() + HARD_CAP_MS;
    let lastEditedCount = -1;

    while (true) {
      await sleep(POLL_MS);

      const now      = Date.now();
      const idleMs   = now - session.lastMessageAt;
      const capReached = now >= hardDeadline;

      // Update the collection message if count changed (live feed)
      if (session.entries.length !== lastEditedCount) {
        lastEditedCount = session.entries.length;
        bot.editMessageText(
          `📥 *Collecting messages\\.\\.\\.*\n\n` +
          `Queue: *${session.entries.length}* QR${session.entries.length === 1 ? "" : "s"} collected so far\\.\\.\\.`,
          { chat_id: chatId, message_id: collectMsg.message_id, parse_mode: "MarkdownV2" },
        ).catch(() => {});
      }

      if (idleMs >= IDLE_TIMEOUT_MS || capReached) break;
    }

    // ── Phase 2: Snapshot ─────────────────────────────────────────────────────
    const entriesToCheck = [...session.entries];
    sessions.delete(chatId);   // free session — user can start a new batch now

    const total = entriesToCheck.length;

    if (total === 0) {
      await bot.editMessageText(
        `⚠️ *No QR entries found\\.*\n\nNo messages with QR numbers were received\\.`,
        { chat_id: chatId, message_id: collectMsg.message_id, parse_mode: "MarkdownV2" },
      ).catch(() => {});
      return;
    }

    // Update message: start verifying
    await bot.editMessageText(
      `⏳ *Verifying ${total} QR${total === 1 ? "" : "s"}\\.\\.\\.*\n\n░░░░░░░░░░ 0%\n*0 / ${total}* done`,
      { chat_id: chatId, message_id: collectMsg.message_id, parse_mode: "MarkdownV2" },
    ).catch(() => {});

    // ── Phase 3: Verify with concurrency limit ────────────────────────────────
    let completed  = 0;
    let lastEdited = 0;
    const EDIT_EVERY = Math.max(1, Math.floor(total / 10));

    const tasks = entriesToCheck.map((entry) => async (): Promise<QRResult> => {
      const status: ResultStatus = entry.paymentUrl
        ? await checkPaymentStatus(entry.paymentUrl)
        : "nolink";

      completed++;

      if (completed - lastEdited >= EDIT_EVERY || completed === total) {
        lastEdited = completed;
        const pct = Math.round((completed / total) * 100);
        bot.editMessageText(
          `⏳ *Verifying ${total} QR${total === 1 ? "" : "s"}\\.\\.\\.*\n\n${buildProgressBar(pct)}\n*${completed} / ${total}* done`,
          { chat_id: chatId, message_id: collectMsg.message_id, parse_mode: "MarkdownV2" },
        ).catch(() => {});
      }

      return { qrNumber: entry.qrNumber, status };
    });

    const results = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

    try { await bot.deleteMessage(chatId, collectMsg.message_id); } catch { /* ignore */ }

    await bot.sendMessage(chatId, buildReport(results), { parse_mode: "Markdown" });
  });

  // ── Regular messages: collect QR entries ─────────────────────────────────────
  bot.on("message", async (msg) => {
    const chatId   = msg.chat.id;
    const text     = msg.text || msg.caption || "";
    const entities = msg.entities || msg.caption_entities || [];

    if (text.startsWith("/")) return;
    if (!text.trim()) return;
    if (!/QR\s*#?\s*\d+/i.test(text)) return;   // matches QR#67, QR 67, QR#67 etc.

    const newEntries = parseQREntries(text, entities);
    if (newEntries.length === 0) return;

    const session = getSession(chatId);

    // Deduplicate by QR number
    const existingNums = new Set(session.entries.map((e) => e.qrNumber));
    const added = newEntries.filter((e) => !existingNums.has(e.qrNumber));
    if (added.length === 0) return;

    session.entries.push(...added);
    session.lastMessageAt = Date.now();   // always update — used by sliding window

    // If /done window is active, silently add and let the countdown loop show it
    if (session.donePending) return;

    // Otherwise debounce ack: one reply after silence
    session.pendingAckCount += added.length;
    if (session.ackTimer) clearTimeout(session.ackTimer);

    session.ackTimer = setTimeout(async () => {
      const acked = session.pendingAckCount;
      session.pendingAckCount = 0;
      session.ackTimer = null;
      const total = session.entries.length;

      await bot.sendMessage(chatId,
        `➕ *${acked} QR${acked === 1 ? "" : "s"} added* — Queue: *${total}* total\n\nSend more or type /done to check all now\\.`,
        { parse_mode: "MarkdownV2" },
      ).catch((err: unknown) => logger.warn({ err }, "Failed to send ack"));
    }, ACK_DEBOUNCE_MS);
  });

  bot.on("polling_error", (err) => {
    logger.error({ err }, "Telegram polling error");
  });
}
