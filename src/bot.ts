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
  const qrPattern = /QR\s*#(\d+)/gi;
  const qrMatches: { number: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = qrPattern.exec(text)) !== null) {
    qrMatches.push({ number: match[1], index: match.index });
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

// ── Stripe direct API approach ──────────────────────────────────────────────
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
    logger.warn({ url }, "No Stripe payload meta tag found in page");
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  } catch {
    logger.warn({ url }, "Failed to decode Stripe payload JSON");
    return null;
  }

  const clientSecret = payload["client_secret"] as string | undefined;
  const pubKey = payload["publishable_key"] as string | undefined;

  if (!clientSecret || !pubKey) {
    logger.warn({ url, payloadKeys: Object.keys(payload) }, "Missing keys in payload");
    return null;
  }

  return { clientSecret, pubKey };
}

async function checkPaymentStatus(url: string): Promise<PaymentStatus> {
  try {
    const payload = await fetchStripePayload(url);
    if (!payload) return "unknown";

    const { clientSecret, pubKey } = payload;

    const intentId = clientSecret.split("_secret_")[0];
    const intentType = intentId.startsWith("seti_")
      ? "setup_intents"
      : "payment_intents";

    const apiUrl = `https://api.stripe.com/v1/${intentType}/${intentId}?client_secret=${encodeURIComponent(clientSecret)}`;
    const authHeader = "Basic " + Buffer.from(pubKey + ":").toString("base64");

    const apiResp = await fetch(apiUrl, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(12000),
    });

    const data = (await apiResp.json()) as Record<string, unknown>;
    const status = data["status"] as string | undefined;

    logger.info({ url, intentId, intentType, status }, "Stripe API status");

    if (status === "succeeded" || status === "requires_capture") return "verified";
    if (status === "canceled" || status === "requires_payment_method") return "expired";

    return "unknown";
  } catch (err) {
    logger.error({ err, url }, "Error checking Stripe payment status");
    return "unknown";
  }
}

// ── Concurrency-limited runner ─────────────────────────────────────────────
// Runs at most `limit` tasks simultaneously instead of all at once.
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

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ResultStatus = PaymentStatus | "nolink";

interface QRResult {
  qrNumber: string;
  status: ResultStatus;
}

// ── Per-chat session ──────────────────────────────────────────────────────
interface ChatSession {
  entries: QREntry[];
  // True while we are in the /done collection-window — message handler still
  // adds entries but suppresses ack replies.
  donePending: boolean;
  ackTimer: NodeJS.Timeout | null;
  pendingAckCount: number;
}

const sessions = new Map<number, ChatSession>();

function getSession(chatId: number): ChatSession {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      entries: [],
      donePending: false,
      ackTimer: null,
      pendingAckCount: 0,
    });
  }
  return sessions.get(chatId)!;
}

function buildProgressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  const empty  = 10 - filled;
  return `${"█".repeat(filled)}${"░".repeat(empty)} ${pct}%`;
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

Welcome\\! This bot instantly verifies the status of UPI QR payment links using Stripe's API\\.

*📌 What this bot does:*
• Collects UPI QR payment entries you forward
• Checks each payment link via Stripe API
• Reports whether each QR is ✅ Verified, ❌ Expired, ❓ Pending, or ⚠️ Has no link

*🚀 How to use:*
1\\. Forward or paste messages containing *QR \\#number* entries with payment links
2\\. Keep sending as many QR messages as you need \\(even 100\\+\\)
3\\. Type /done when finished — the bot waits a few seconds to collect all messages, then checks them all
4\\. Type /reset at any time to clear the list and start fresh

*📋 Commands:*
/start — Show this help message
/status — Show how many QRs are in the queue
/done — Check all collected QR entries
/reset — Clear the current list and start over

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Owner:* @SPIDYWS
`.trim();

// How many seconds to wait after /done before snapshotting.
// This window lets any in-flight Telegram messages arrive first.
const COLLECTION_BUFFER_SECS = 4;

// Max simultaneous Stripe requests
const CONCURRENCY_LIMIT = 10;

// How long to wait before sending a single consolidated ack (ms)
const ACK_DEBOUNCE_MS = 2000;

export function startBot(): void {
  if (!TOKEN) return;

  // Use a short polling interval so messages arrive quickly
  const bot = new TelegramBot(TOKEN, {
    polling: {
      interval: 100,
      autoStart: true,
      params: { limit: 100, timeout: 10 },
    },
  });
  logger.info("Telegram bot started with polling");

  // ── /start ──────────────────────────────────────────────────────────────
  bot.onText(/^\/start$/i, async (msg) => {
    await bot.sendMessage(msg.chat.id, START_MESSAGE, { parse_mode: "MarkdownV2" });
  });

  // ── /status ──────────────────────────────────────────────────────────────
  bot.onText(/^\/status$/i, async (msg) => {
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    const count = session.entries.length;
    if (count === 0) {
      await bot.sendMessage(chatId,
        `📭 *Queue is empty*\n\nNo QR entries collected yet\\. Send some messages and try again\\.`,
        { parse_mode: "MarkdownV2" });
    } else {
      await bot.sendMessage(chatId,
        `📬 *Queue Status*\n\n*${count}* QR entr${count === 1 ? "y" : "ies"} ready to check\\.\nType /done to process them now\\.`,
        { parse_mode: "MarkdownV2" });
    }
  });

  // ── /reset ───────────────────────────────────────────────────────────────
  bot.onText(/^\/reset$/i, async (msg) => {
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    if (session.ackTimer) clearTimeout(session.ackTimer);
    sessions.delete(chatId);
    await bot.sendMessage(chatId,
      `🔄 *Session Reset\\!*\n\nYour QR list has been cleared\\. Send new QR messages and type /done when ready\\.`,
      { parse_mode: "MarkdownV2" });
  });

  // ── /done — collect for a window, then process ───────────────────────────
  bot.onText(/^\/done$/i, async (msg) => {
    const chatId = msg.chat.id;
    const session = getSession(chatId);

    // Ignore duplicate /done while one is already in progress
    if (session.donePending) return;

    // Cancel any pending debounced ack
    if (session.ackTimer) {
      clearTimeout(session.ackTimer);
      session.ackTimer = null;
    }

    if (session.entries.length === 0) {
      await bot.sendMessage(chatId,
        `⚠️ *No QR entries found\\!*\n\nPlease send messages containing QR entries first, then type /done\\.`,
        { parse_mode: "MarkdownV2" });
      return;
    }

    // Mark session as done-pending so:
    //   • message handler keeps adding entries (without sending ack)
    //   • duplicate /done commands are ignored
    session.donePending = true;

    // ── Phase 1: Collection window ─────────────────────────────────────
    // Wait COLLECTION_BUFFER_SECS seconds so any in-flight Telegram messages
    // (not yet delivered by polling) can arrive and be added to the session.
    const collectMsg = await bot.sendMessage(chatId,
      `📥 *Collecting all messages\\.\\.\\.*\n\n` +
      `⏱ Waiting ${COLLECTION_BUFFER_SECS}s to make sure every QR is received\\.\n` +
      `Queue so far: *${session.entries.length}* QR(s)`,
      { parse_mode: "MarkdownV2" });

    for (let sec = COLLECTION_BUFFER_SECS - 1; sec >= 0; sec--) {
      await sleep(1000);
      // Update the countdown and live queue count so user can watch it grow
      await bot.editMessageText(
        sec > 0
          ? `📥 *Collecting all messages\\.\\.\\.*\n\n` +
            `⏱ Starting in *${sec}s*\\.\\.\\.\n` +
            `Queue so far: *${session.entries.length}* QR(s)`
          : `📥 *Collection complete\\!*\n\n` +
            `✅ Captured *${session.entries.length}* QR(s) total\\. Starting verification\\.\\.\\.`,
        {
          chat_id: chatId,
          message_id: collectMsg.message_id,
          parse_mode: "MarkdownV2",
        },
      ).catch(() => {});
    }

    // ── Phase 2: Snapshot & verify ────────────────────────────────────
    // Now all in-flight messages have had time to arrive.
    const entriesToCheck = [...session.entries];
    sessions.delete(chatId); // clear session — user can start a new batch

    const total = entriesToCheck.length;

    if (total === 0) {
      await bot.editMessageText(`⚠️ *No QR entries found after collection window\\.* Please try again\\.`,
        { chat_id: chatId, message_id: collectMsg.message_id, parse_mode: "MarkdownV2" }).catch(() => {});
      return;
    }

    // Replace the collection message with the progress message
    await bot.editMessageText(
      `⏳ *Verifying ${total} QR entr${total === 1 ? "y" : "ies"}*\n\n` +
      `░░░░░░░░░░ 0%\n*0 / ${total}* checked`,
      { chat_id: chatId, message_id: collectMsg.message_id, parse_mode: "MarkdownV2" },
    ).catch(() => {});

    let completed = 0;
    let lastEdited = 0;
    const EDIT_EVERY = Math.max(1, Math.floor(total / 10));

    const tasks = entriesToCheck.map((entry) => async (): Promise<QRResult> => {
      let status: ResultStatus;
      if (!entry.paymentUrl) {
        status = "nolink";
      } else {
        status = await checkPaymentStatus(entry.paymentUrl);
      }

      completed++;

      if (completed - lastEdited >= EDIT_EVERY || completed === total) {
        lastEdited = completed;
        const pct = Math.round((completed / total) * 100);
        const bar = buildProgressBar(pct);
        bot.editMessageText(
          `⏳ *Verifying ${total} QR entr${total === 1 ? "y" : "ies"}*\n\n${bar}\n*${completed} / ${total}* checked`,
          {
            chat_id: chatId,
            message_id: collectMsg.message_id,
            parse_mode: "MarkdownV2",
          },
        ).catch(() => {});
      }

      return { qrNumber: entry.qrNumber, status };
    });

    const results = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

    try {
      await bot.deleteMessage(chatId, collectMsg.message_id);
    } catch { /* ignore */ }

    await bot.sendMessage(chatId, buildReport(results), { parse_mode: "Markdown" });
  });

  // ── Regular messages — collect QR entries ────────────────────────────────
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || msg.caption || "";
    const entities = msg.entities || msg.caption_entities || [];

    if (text.startsWith("/")) return;
    if (!text.trim()) return;
    if (!/QR\s*#\d+/i.test(text)) return;

    const newEntries = parseQREntries(text, entities);
    if (newEntries.length === 0) return;

    const session = getSession(chatId);

    // Deduplicate by QR number
    const existingNums = new Set(session.entries.map((e) => e.qrNumber));
    const added = newEntries.filter((e) => !existingNums.has(e.qrNumber));
    if (added.length === 0) return;

    session.entries.push(...added);

    // If /done is already counting down, just silently add — no ack needed.
    // The countdown message shows the live queue count.
    if (session.donePending) return;

    // Otherwise, debounce the ack: reset timer, fire ONE reply after silence
    session.pendingAckCount += added.length;
    if (session.ackTimer) clearTimeout(session.ackTimer);

    session.ackTimer = setTimeout(async () => {
      const acked = session.pendingAckCount;
      session.pendingAckCount = 0;
      session.ackTimer = null;
      const total = session.entries.length;

      await bot.sendMessage(
        chatId,
        `➕ *${acked} QR entr${acked === 1 ? "y" : "ies"} added* — Queue: *${total}* total\n\nSend more, or type /done to check all of them now\\.`,
        { parse_mode: "MarkdownV2" },
      ).catch((err: unknown) => logger.warn({ err }, "Failed to send ack"));
    }, ACK_DEBOUNCE_MS);
  });

  bot.on("polling_error", (err) => {
    logger.error({ err }, "Telegram polling error");
  });
}
