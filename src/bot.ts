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
  // Find all QR numbers in order of appearance
  const qrPattern = /QR\s*#(\d+)/gi;
  const qrMatches: { number: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = qrPattern.exec(text)) !== null) {
    qrMatches.push({ number: match[1], index: match.index });
  }

  if (qrMatches.length === 0) return [];

  // Find all text_link entities (the payment links) sorted by position
  const linkEntities = (entities || [])
    .filter((e) => e.type === "text_link" && e.url)
    .sort((a, b) => a.offset - b.offset);

  // Match each QR number with the corresponding link entity (positional)
  return qrMatches.map((qr, i) => ({
    qrNumber: qr.number,
    paymentUrl: linkEntities[i]?.url ?? null,
  }));
}

type PaymentStatus = "verified" | "expired" | "unknown";

// ── Stripe direct API approach ──────────────────────────────────────────────
// Stripe's UPI hosted payment page embeds a base64 JSON payload in a <meta> tag
// that contains the publishable_key and client_secret. We fetch the HTML, extract
// that payload, then call the Stripe API directly — no browser needed.

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

  // Extract data-message attribute from <meta id="payload" data-message="...">
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

    // Determine intent type from the client_secret prefix
    const intentId = clientSecret.split("_secret_")[0]; // e.g. seti_xxx or pi_xxx
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

    // ── Map Stripe status to our result ──────────────────────────────────
    // SetupIntents: succeeded | canceled | processing | requires_action | requires_payment_method | requires_confirmation
    // PaymentIntents: succeeded | canceled | processing | requires_action | requires_payment_method | requires_capture | requires_confirmation
    if (status === "succeeded" || status === "requires_capture") {
      return "verified";
    }

    if (
      status === "canceled" ||
      status === "requires_payment_method" // payment never attempted / expired session
    ) {
      return "expired";
    }

    // processing / requires_action / requires_confirmation → still in flight
    return "unknown";
  } catch (err) {
    logger.error({ err, url }, "Error checking Stripe payment status");
    return "unknown";
  }
}

type ResultStatus = PaymentStatus | "nolink";

interface QRResult {
  qrNumber: string;
  status: ResultStatus;
}

// ── Per-chat session: accumulate entries until /done ──────────────────────────
interface ChatSession {
  entries: QREntry[]; // collected so far
}

const sessions = new Map<number, ChatSession>();

function getSession(chatId: number): ChatSession {
  if (!sessions.has(chatId)) sessions.set(chatId, { entries: [] });
  return sessions.get(chatId)!;
}

function buildReport(results: QRResult[]): string {
  const verified = results.filter((r) => r.status === "verified");
  const expired  = results.filter((r) => r.status === "expired");
  const unknown  = results.filter((r) => r.status === "unknown");
  const noLink   = results.filter((r) => r.status === "nolink");

  const lines: string[] = [];
  lines.push(`📋 *Payment Verification Report*`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (verified.length > 0) {
    lines.push(`\n✅ *VERIFIED (${verified.length})*`);
    verified.forEach((r) => lines.push(`  • QR #${r.qrNumber}`));
  }

  if (expired.length > 0) {
    lines.push(`\n❌ *EXPIRED (${expired.length})*`);
    expired.forEach((r) => lines.push(`  • QR #${r.qrNumber}`));
  }

  if (unknown.length > 0) {
    lines.push(`\n❓ *UNKNOWN / PENDING (${unknown.length})*`);
    unknown.forEach((r) => lines.push(`  • QR #${r.qrNumber}`));
  }

  if (noLink.length > 0) {
    lines.push(`\n⚠️ *LINK NAHI MILA (${noLink.length})*`);
    noLink.forEach((r) => lines.push(`  • QR #${r.qrNumber}`));
  }

  lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(
    `📊 *Total: ${results.length}*  |  ✅ Verified: ${verified.length}  |  ❌ Expired: ${expired.length}`,
  );

  return lines.join("\n");
}

export function startBot(): void {
  if (!TOKEN) return;

  const bot = new TelegramBot(TOKEN, { polling: true });
  logger.info("Telegram bot started with polling");

  // ── /reset — clear session ──────────────────────────────────────────────
  bot.onText(/^\/reset$/i, async (msg) => {
    const chatId = msg.chat.id;
    sessions.delete(chatId);
    await bot.sendMessage(
      chatId,
      "🔄 *Reset ho gaya!*\nAb nayi list shuru karo — QRs bhejo aur jab done ho `/done` likho.",
      { parse_mode: "Markdown" },
    );
  });

  // ── /done — process all collected entries ───────────────────────────────
  bot.onText(/^\/done$/i, async (msg) => {
    const chatId = msg.chat.id;
    const session = getSession(chatId);

    if (session.entries.length === 0) {
      await bot.sendMessage(
        chatId,
        "⚠️ Koi QR abhi tak add nahi hua.\nPehle QR messages bhejo, phir `/done` likho.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const total = session.entries.length;
    const processingMsg = await bot.sendMessage(
      chatId,
      `🔄 *${total} QR check ho rahi hain...*\nThoda wait karo ⏳`,
      { parse_mode: "Markdown" },
    );

    // Check all in parallel
    const results: QRResult[] = await Promise.all(
      session.entries.map(async (entry): Promise<QRResult> => {
        if (!entry.paymentUrl) {
          return { qrNumber: entry.qrNumber, status: "nolink" };
        }
        const status = await checkPaymentStatus(entry.paymentUrl);
        return { qrNumber: entry.qrNumber, status };
      }),
    );

    // Clear session after processing
    sessions.delete(chatId);

    try {
      await bot.deleteMessage(chatId, processingMsg.message_id);
    } catch { /* ignore */ }

    await bot.sendMessage(chatId, buildReport(results), {
      parse_mode: "Markdown",
    });
  });

  // ── Regular messages — collect QR entries ──────────────────────────────
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || msg.caption || "";
    const entities = msg.entities || msg.caption_entities || [];

    // Ignore commands (handled above)
    if (text.startsWith("/")) return;
    if (!text.trim()) return;

    // Only process messages containing QR entries
    if (!/QR\s*#\d+/i.test(text)) return;

    const newEntries = parseQREntries(text, entities);
    if (newEntries.length === 0) return;

    const session = getSession(chatId);

    // Deduplicate by QR number
    const existingNums = new Set(session.entries.map((e) => e.qrNumber));
    const added = newEntries.filter((e) => !existingNums.has(e.qrNumber));
    session.entries.push(...added);

    const total = session.entries.length;
    await bot.sendMessage(
      chatId,
      `➕ *${added.length} QR add hua* — Total: *${total}*\nAur bhejo, ya /done likho jab sab ho jaye.`,
      { parse_mode: "Markdown" },
    );
  });

  bot.on("polling_error", (err) => {
    logger.error({ err }, "Telegram polling error");
  });
}
