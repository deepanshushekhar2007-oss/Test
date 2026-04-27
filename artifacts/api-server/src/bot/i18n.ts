import { createHash } from "crypto";
import { getCollection } from "./mongodb";

// ─────────────────────────────────────────────────────────────────────────────
// Per-user language preference + on-the-fly translation engine.
//
// "default" = no translation, original Hindi+English text as-is (fastest).
// Any other lang = Google Translate free endpoint with 2-tier cache:
//   1. In-memory Map (LRU-bounded, instant)
//   2. MongoDB `translation_cache` collection (survives restarts)
// HTML tags, URLs, phone numbers, and the bot brand name are protected
// from translation via sentinel placeholders.
// ─────────────────────────────────────────────────────────────────────────────

export type Language = "default" | "en" | "hi" | "id" | "zh";

export const LANGUAGES: Record<Exclude<Language, "default">, { name: string; nativeName: string; gtCode: string; flag: string }> = {
  en: { name: "English", nativeName: "English", gtCode: "en", flag: "🇬🇧" },
  hi: { name: "Hindi", nativeName: "हिन्दी", gtCode: "hi", flag: "🇮🇳" },
  id: { name: "Indonesian", nativeName: "Bahasa Indonesia", gtCode: "id", flag: "🇮🇩" },
  zh: { name: "Chinese", nativeName: "中文", gtCode: "zh-CN", flag: "🇨🇳" },
};

const VALID_LANGS = new Set<Language>(["default", "en", "hi", "id", "zh"]);

// ── User language storage ──────────────────────────────────────────────────
const userLanguages = new Map<number, Language>();
let loaded = false;

export function getUserLang(userId: number): Language {
  return userLanguages.get(userId) ?? "default";
}

export function hasUserLang(userId: number): boolean {
  return userLanguages.has(userId);
}

export async function loadUserLanguages(): Promise<void> {
  if (loaded) return;
  try {
    const col = await getCollection("user_languages");
    const docs = await col.find({}).toArray();
    for (const doc of docs) {
      const uid = Number(doc._id);
      const lang = doc.lang as Language;
      if (Number.isFinite(uid) && VALID_LANGS.has(lang)) {
        userLanguages.set(uid, lang);
      }
    }
    loaded = true;
    console.log(`[i18n] Loaded ${userLanguages.size} user language preferences`);
  } catch (err: any) {
    console.error("[i18n] loadUserLanguages error:", err?.message);
  }
}

export async function setUserLanguage(userId: number, lang: Language): Promise<void> {
  if (!VALID_LANGS.has(lang)) return;
  userLanguages.set(userId, lang);
  try {
    const col = await getCollection("user_languages");
    await col.updateOne(
      { _id: userId as any },
      { $set: { lang, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (err: any) {
    console.error("[i18n] setUserLanguage error:", err?.message);
  }
}

// ── Translation cache ──────────────────────────────────────────────────────
// Bounded in-memory cache. Each entry ~200 bytes; cap at 5000 entries → ~1 MB.
const MEM_CACHE_MAX = 5000;
const memCache = new Map<string, string>();

function cacheKey(text: string, lang: Language): string {
  // Short hash so the key stays small in MongoDB indices.
  const h = createHash("sha1").update(text).digest("hex").slice(0, 24);
  return `${lang}:${h}`;
}

function memGet(key: string): string | undefined {
  const v = memCache.get(key);
  if (v !== undefined) {
    // LRU touch
    memCache.delete(key);
    memCache.set(key, v);
  }
  return v;
}

function memSet(key: string, value: string): void {
  if (memCache.size >= MEM_CACHE_MAX) {
    // Evict oldest (first inserted)
    const first = memCache.keys().next().value;
    if (first) memCache.delete(first);
  }
  memCache.set(key, value);
}

async function dbGet(key: string): Promise<string | undefined> {
  try {
    const col = await getCollection("translation_cache");
    const doc = await col.findOne({ _id: key as any });
    if (doc && typeof doc.dst === "string") return doc.dst;
  } catch (err: any) {
    console.error("[i18n] dbGet error:", err?.message);
  }
  return undefined;
}

async function dbSet(key: string, lang: Language, src: string, dst: string): Promise<void> {
  try {
    const col = await getCollection("translation_cache");
    await col.updateOne(
      { _id: key as any },
      { $set: { lang, src, dst, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (err: any) {
    console.error("[i18n] dbSet error:", err?.message);
  }
}

// ── No-translate sentinel ──────────────────────────────────────────────────
// Some messages (e.g. the language picker itself, dynamic content like phone
// numbers, raw URLs only) shouldn't be auto-translated. Wrap them with notr()
// and the API transformer will strip the marker and skip translation.
export const NOTR_PREFIX = "\u200B\u200B"; // 2× zero-width space — invisible

export function notr(text: string): string {
  return NOTR_PREFIX + text;
}

export function isNotr(text: string): boolean {
  return typeof text === "string" && text.startsWith(NOTR_PREFIX);
}

export function stripNotr(text: string): string {
  return text.startsWith(NOTR_PREFIX) ? text.slice(NOTR_PREFIX.length) : text;
}

// ── HTML / URL / brand name protection ─────────────────────────────────────
// Replace patterns we don't want translated with sentinel tokens that survive
// a round-trip through Google Translate, then restore them after.
const BRAND_PATTERNS: RegExp[] = [
  /ᴡꜱ ᴀᴜᴛᴏᴍᴀᴛɪᴏɴ/g,       // bot display name
  /@[A-Za-z0-9_]+/g,            // @usernames (e.g. @SPIDYWS)
];

function protect(text: string): { protectedText: string; tokens: string[] } {
  const tokens: string[] = [];
  let out = text;
  // Sentinel format: ⟦⟦n⟧⟧ — uses uncommon chars Google Translate leaves alone.
  const push = (matched: string) => {
    const idx = tokens.length;
    tokens.push(matched);
    return `⟦⟦${idx}⟧⟧`;
  };
  // 1. HTML tags
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, (m) => push(m));
  // 2. URLs (incl. https://chat.whatsapp.com/...)
  out = out.replace(/https?:\/\/\S+/g, (m) => push(m));
  // 3. Brand patterns
  for (const re of BRAND_PATTERNS) out = out.replace(re, (m) => push(m));
  return { protectedText: out, tokens };
}

function restore(text: string, tokens: string[]): string {
  // Google Translate occasionally adds spaces inside our sentinels or
  // around them. Use a permissive regex when restoring.
  return text.replace(/⟦\s*⟦\s*(\d+)\s*⟧\s*⟧/g, (_m, n) => {
    const idx = Number(n);
    return tokens[idx] ?? _m;
  });
}

// ── Google Translate (free endpoint) ───────────────────────────────────────
// We use the unofficial free Google Translate endpoints. From cloud IPs (e.g.
// Render) they sometimes rate-limit (HTTP 429) or briefly block. The design
// goals here are FAST FAILURE on the cache-miss path so the bot never appears
// frozen while the i18n layer waits for Google:
//
//   1. Browser-like User-Agent — a bare Node fetch with no UA gets blocked.
//   2. Per-request 2.5s timeout (AbortSignal) so a slow endpoint can't stall.
//   3. Try 2 distinct endpoints (different host + client tuple) with no
//      backoff between them; total worst-case 2 × 2.5s = 5s per cache miss.
//   4. A circuit breaker: if Google fails 3 times in a row, "open" the
//      circuit for 30s — every subsequent translate() call returns original
//      text instantly so the bot stays snappy. After the cool-down we probe
//      Google again automatically.
//   5. Per-string negative cache: when one specific string fails to
//      translate we mark it as "skip for 60s" so we don't keep paying the
//      5s penalty on every render of the same screen.
//   6. A bounded semaphore caps simultaneous outbound calls so a single
//      feature open can't fan out 20 parallel requests.

const GT_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36";

const GT_REQUEST_TIMEOUT_MS = 2500;
const GT_MAX_CONCURRENCY = 8;
const GT_CIRCUIT_THRESHOLD = 3;
const GT_CIRCUIT_OPEN_MS = 30_000;
const GT_NEG_CACHE_MS = 60_000;

type GtEndpoint = "gtx" | "at";

async function gtTranslateOnce(text: string, gtCode: string, endpoint: GtEndpoint): Promise<string> {
  const url =
    endpoint === "gtx"
      ? `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(gtCode)}&dt=t&dj=1`
      : `https://translate.google.com/translate_a/single?client=at&sl=auto&tl=${encodeURIComponent(gtCode)}&dt=t&dj=1`;
  const body = `q=${encodeURIComponent(text)}`;
  // AbortSignal.timeout exists in Node >= 17.3; we know we're on a modern
  // Node here because the rest of the project uses native fetch.
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": GT_USER_AGENT,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body,
    signal: AbortSignal.timeout(GT_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GT ${endpoint} ${res.status}`);
  const data: any = await res.json();
  // dj=1 → object form: { sentences: [{ trans, orig, ... }, ...] }
  if (data && Array.isArray(data.sentences)) {
    let out = "";
    for (const s of data.sentences) if (typeof s.trans === "string") out += s.trans;
    return out || text;
  }
  // Legacy array form: data[0] = array of segments [[translated, orig, ...], ...]
  if (Array.isArray(data) && Array.isArray(data[0])) {
    let out = "";
    for (const seg of data[0]) if (Array.isArray(seg) && typeof seg[0] === "string") out += seg[0];
    return out || text;
  }
  return text;
}

// ── Concurrency semaphore ────────────────────────────────────────────────
let gtActive = 0;
const gtWaitQueue: Array<() => void> = [];

async function gtAcquire(): Promise<void> {
  if (gtActive < GT_MAX_CONCURRENCY) {
    gtActive++;
    return;
  }
  await new Promise<void>((resolve) => gtWaitQueue.push(resolve));
  gtActive++;
}

function gtRelease(): void {
  gtActive--;
  const next = gtWaitQueue.shift();
  if (next) next();
}

// ── Circuit breaker ──────────────────────────────────────────────────────
let gtConsecutiveFailures = 0;
let gtCircuitOpenUntil = 0;

function gtCircuitIsOpen(): boolean {
  return Date.now() < gtCircuitOpenUntil;
}

function gtRecordSuccess(): void {
  gtConsecutiveFailures = 0;
  gtCircuitOpenUntil = 0;
}

function gtRecordFailure(): void {
  gtConsecutiveFailures++;
  if (gtConsecutiveFailures >= GT_CIRCUIT_THRESHOLD && !gtCircuitIsOpen()) {
    gtCircuitOpenUntil = Date.now() + GT_CIRCUIT_OPEN_MS;
    console.warn(
      `[i18n] Google Translate circuit OPEN for ${GT_CIRCUIT_OPEN_MS / 1000}s after ${gtConsecutiveFailures} failures`
    );
    // Reset the counter so we don't immediately re-open right after the cool-down.
    gtConsecutiveFailures = 0;
  }
}

async function gtTranslate(text: string, gtCode: string): Promise<string> {
  if (gtCircuitIsOpen()) throw new Error("GT circuit open");
  const ATTEMPTS: GtEndpoint[] = ["gtx", "at"];
  await gtAcquire();
  try {
    let lastErr: any;
    for (let i = 0; i < ATTEMPTS.length; i++) {
      try {
        const result = await gtTranslateOnce(text, gtCode, ATTEMPTS[i]);
        gtRecordSuccess();
        return result;
      } catch (err: any) {
        lastErr = err;
      }
    }
    gtRecordFailure();
    throw lastErr ?? new Error("GT all attempts failed");
  } finally {
    gtRelease();
  }
}

// In-flight request dedup so concurrent users translating the same string
// don't fire 5 parallel HTTP calls.
const inflight = new Map<string, Promise<string>>();

// Per-string negative cache: when one specific string fails, mark it as
// "skip for N ms" so re-renders of the same screen don't keep paying the
// retry cost. Cleared on a successful retranslation.
const negCacheUntil = new Map<string, number>();

export async function translate(text: string, lang: Language): Promise<string> {
  if (!text || lang === "default") return text;
  const meta = LANGUAGES[lang as Exclude<Language, "default">];
  if (!meta) return text;
  const key = cacheKey(text, lang);

  // L1: in-memory cache (success cache — translated text)
  const hit = memGet(key);
  if (hit !== undefined) return hit;

  // L1b: per-string negative cache. If this exact string failed recently,
  // skip the network round-trip entirely and return original. Keeps the bot
  // snappy when one phrase is hard to translate or Google is rate-limiting.
  const negUntil = negCacheUntil.get(key);
  if (negUntil) {
    if (Date.now() < negUntil) return text;
    negCacheUntil.delete(key);
  }

  // L2: MongoDB cache (survives restarts)
  const dbHit = await dbGet(key);
  if (dbHit !== undefined) {
    memSet(key, dbHit);
    return dbHit;
  }

  // L3: live Google Translate (deduped per key)
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const { protectedText, tokens } = protect(text);
      const translated = await gtTranslate(protectedText, meta.gtCode);
      const restored = restore(translated, tokens);
      memSet(key, restored);
      // Persist async — don't block response on DB write.
      void dbSet(key, lang, text, restored);
      return restored;
    } catch (err: any) {
      // Negatively cache this string so subsequent renders of the same
      // screen don't keep paying the Google round-trip cost.
      negCacheUntil.set(key, Date.now() + GT_NEG_CACHE_MS);
      // Only log non-circuit-open failures — circuit-open is expected and
      // would otherwise spam the log every render while the breaker is open.
      const msg = String(err?.message || "");
      if (!msg.includes("circuit open")) {
        console.error(`[i18n] translate(${lang}) failed:`, msg);
      }
      return text; // graceful fallback to original
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// Translate every button label inside an inline keyboard payload, in parallel.
// On default lang we still walk the keyboard to strip any notr() markers so
// they never reach Telegram.
export async function translateInlineKeyboard(rm: any, lang: Language): Promise<any> {
  if (!rm) return rm;
  const kb = rm.inline_keyboard;
  if (!Array.isArray(kb)) return rm;
  const newKb = await Promise.all(
    kb.map(async (row: any[]) =>
      Promise.all(
        row.map(async (btn: any) => {
          if (!btn || typeof btn.text !== "string") return btn;
          if (isNotr(btn.text)) {
            return { ...btn, text: stripNotr(btn.text) };
          }
          if (lang === "default") return btn;
          return { ...btn, text: await translate(btn.text, lang) };
        })
      )
    )
  );
  return { ...rm, inline_keyboard: newKb };
}

// ── Warm-up: pre-translate common UI strings with progress callback ────────
// Used by the language picker to warm the cache before showing the main menu,
// so the first interaction in the new language feels instant.
export const COMMON_UI_STRINGS: string[] = [
  // ── Top-level navigation buttons ─────────────────────────────────────────
  "🏠 Main Menu",
  "🏠 Menu",
  "🔙 Back",
  "❌ Cancel",
  "⏭️ Skip",
  "✅ Yes",
  "❌ No",
  "✅ Confirm",
  "▶️ Continue",
  "⏹️ Stop",
  "⏪ Prev",
  "⏩ Next",
  "🔄 Refresh",
  "📤 Export",
  "📥 Import",
  // ── Main feature buttons ─────────────────────────────────────────────────
  "📱 Connect WhatsApp",
  "📱 Connect",
  "🔌 Disconnect",
  "🔄 Session Refresh",
  "👥 Create Groups",
  "🔗 Join Groups",
  "🔍 CTC Checker",
  "🔗 Get Link",
  "🚪 Leave Group",
  "🗑️ Remove Members",
  "👑 Make Admin",
  "✅ Approval",
  "📋 Get Pending List",
  "➕ Add Members",
  "⚙️ Edit Settings",
  "🤖 Auto Chat",
  // ── Selection / pagination helpers (used by every list-based feature) ───
  "☑️ Select All",
  "🧹 Clear All",
  "🧹 Clear",
  "✅ Apply",
  "✅ Apply to All Groups",
  "🔍 Similar Groups",
  "📋 All Groups",
  "📌 Select an option:",
  "📌 Choose an option:",
  "Choose an option below:",
  "Choose an option:",
  "Tap to select/deselect",
  "None selected",
  "Use Prev/Next to change page",
  // ── Status / progress copy ───────────────────────────────────────────────
  "Processing...",
  "Please wait...",
  "Done!",
  "Loading menu...",
  "Fetching...",
  "Sending...",
  "Connecting...",
  "Disconnecting...",
  // ── Feature panel headers + counters ─────────────────────────────────────
  "✨ <b>Main Menu</b>",
  "👋 <b>Welcome!</b>",
  "📋 <b>Pending List</b>",
  "⚙️ <b>Edit Settings</b>",
  "🔍 <b>Similar Group Patterns</b>",
  "📊 Groups with pending:",
  "⏳ Total Pending:",
  "🔍 Similar Patterns:",
  "📊 Admin Groups:",
  "👑 admin group(s)",
  "Group(s) select karo:",
  "Select groups to show copy-format pending list:",
  "Tap a pattern to select those groups:",
  "Fetching pending requests for all admin groups...",
  "No pending requests found in any group.",
  "⚠️ No similar group patterns found.",
  // ── Common error / status messages ───────────────────────────────────────
  "❌ WhatsApp not connected.",
  "✅ <b>WhatsApp Connected!</b>",
  "📭 Aap kisi bhi group mein admin nahi hain.",
  "Sab clear. Group(s) select karo:",
];

export async function warmUpLanguage(
  lang: Language,
  onProgress?: (done: number, total: number) => void | Promise<void>
): Promise<void> {
  if (lang === "default") return;
  const total = COMMON_UI_STRINGS.length;
  let done = 0;
  // Run with bounded concurrency so we don't hammer Google Translate.
  const CONCURRENCY = 5;
  let cursor = 0;
  async function worker() {
    while (cursor < total) {
      const i = cursor++;
      try {
        await translate(COMMON_UI_STRINGS[i], lang);
      } catch {}
      done++;
      if (onProgress) {
        try { await onProgress(done, total); } catch {}
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
}
