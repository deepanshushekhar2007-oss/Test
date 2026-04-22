import { getCollection } from "./mongodb";
import https from "https";

export type LangCode = "default" | "en" | "hi" | "id" | "zh";

const VALID_LANGS: LangCode[] = ["default", "en", "hi", "id", "zh"];

export const LANG_LABELS: Record<LangCode, string> = {
  default: "🌐 Default (English+Hindi)",
  en: "🇬🇧 English",
  hi: "🇮🇳 Hindi",
  id: "🇮🇩 Indonesian",
  zh: "🇨🇳 Chinese",
};

export const LANG_NAMES: Record<LangCode, string> = {
  default: "Default",
  en: "English",
  hi: "हिन्दी",
  id: "Bahasa Indonesia",
  zh: "中文",
};

const userLangCache = new Map<number, LangCode>();

export function isValidLang(v: string): v is LangCode {
  return (VALID_LANGS as string[]).includes(v);
}

export async function getUserLang(userId: number): Promise<LangCode> {
  if (userLangCache.has(userId)) return userLangCache.get(userId)!;
  try {
    const col = await getCollection("user_lang");
    const doc = await col.findOne({ _id: userId as any });
    const lang = doc && isValidLang(doc.lang) ? (doc.lang as LangCode) : "default";
    userLangCache.set(userId, lang);
    return lang;
  } catch {
    userLangCache.set(userId, "default");
    return "default";
  }
}

export function getUserLangSync(userId: number): LangCode {
  return userLangCache.get(userId) || "default";
}

export async function setUserLang(userId: number, lang: LangCode): Promise<void> {
  userLangCache.set(userId, lang);
  try {
    const col = await getCollection("user_lang");
    await col.updateOne(
      { _id: userId as any },
      { $set: { lang, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (err: any) {
    console.error("[i18n] setUserLang error:", err?.message);
  }
}

// Preload some users' languages into the cache at startup
export async function preloadLangCache(): Promise<void> {
  try {
    const col = await getCollection("user_lang");
    const docs = await col.find({}).limit(5000).toArray();
    for (const d of docs) {
      const id = Number((d as any)._id);
      const lang = (d as any).lang;
      if (Number.isFinite(id) && isValidLang(lang)) {
        userLangCache.set(id, lang as LangCode);
      }
    }
    console.log(`[i18n] Preloaded ${userLangCache.size} user language preferences`);
  } catch (err: any) {
    console.error("[i18n] preloadLangCache error:", err?.message);
  }
}

// ---------------- Translation ----------------

const translateCache = new Map<string, string>();
const MAX_CACHE = 5000;

function cachePut(key: string, value: string) {
  if (translateCache.size >= MAX_CACHE) {
    const firstKey = translateCache.keys().next().value;
    if (firstKey !== undefined) translateCache.delete(firstKey);
  }
  translateCache.set(key, value);
}

// POST-based translation — supports much longer text than GET (no URL limit).
function googleTranslateOnce(text: string, target: string): Promise<string> {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      client: "gtx",
      sl: "auto",
      tl: target,
      dt: "t",
    });
    const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
    const body = new URLSearchParams({ q: text }).toString();
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(buf);
            const segments: string[] = [];
            if (Array.isArray(data) && Array.isArray(data[0])) {
              for (const seg of data[0]) {
                if (Array.isArray(seg) && typeof seg[0] === "string") {
                  segments.push(seg[0]);
                }
              }
            }
            resolve(segments.join("") || text);
          } catch {
            resolve(text);
          }
        });
      }
    );
    req.on("error", () => resolve(text));
    req.setTimeout(15000, () => {
      try {
        req.destroy();
      } catch {}
      resolve(text);
    });
    req.write(body);
    req.end();
  });
}

// Splits very long text into chunks ≤ MAX_CHUNK by line boundaries so each
// piece fits comfortably in one Google Translate request, then translates
// chunks in parallel and rejoins. Keeps separator characters intact.
const MAX_CHUNK = 1800;

function splitForTranslation(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    // If a single line is huge, hard-split it.
    if (line.length > MAX_CHUNK) {
      if (cur) { chunks.push(cur); cur = ""; }
      for (let i = 0; i < line.length; i += MAX_CHUNK) {
        chunks.push(line.slice(i, i + MAX_CHUNK));
      }
      continue;
    }
    if (cur.length + line.length + 1 > MAX_CHUNK) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? cur + "\n" + line : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function googleTranslate(text: string, target: string): Promise<string> {
  const chunks = splitForTranslation(text);
  if (chunks.length === 1) return googleTranslateOnce(text, target);
  const translated = await Promise.all(
    chunks.map((c) => googleTranslateOnce(c, target))
  );
  return translated.join("\n");
}

// HTML-aware translator: preserves all HTML tags (including <pre>/<code>) but
// translates ALL inner text content — including text inside <pre> and <code>
// blocks, since the bot uses <pre> for formatted help text that the user
// actually wants translated.
//
// Strategy:
//   1. Replace each HTML tag with a placeholder (tag itself preserved).
//   2. Translate the resulting text (with placeholders) as a whole.
//   3. Restore tag placeholders.
async function translateHtml(text: string, target: string): Promise<string> {
  if (!text || !text.trim()) return text;

  const tags: string[] = [];
  const tagPh = (i: number) => `[[TT${i}TT]]`;

  // Replace every HTML tag with a placeholder; translate inner text.
  let processed = text.replace(/<\/?[a-zA-Z][^>]*>/g, (m) => {
    tags.push(m);
    return tagPh(tags.length - 1);
  });

  // Quick check: if nothing meaningful to translate
  const stripped = processed.replace(/\[\[TT\d+TT\]\]/g, "").trim();
  if (!stripped) return text;

  // Translate (with cache)
  let translated: string;
  const cacheKey = `${target}|${processed}`;
  const cached = translateCache.get(cacheKey);
  if (cached !== undefined) {
    translated = cached;
  } else {
    translated = await googleTranslate(processed, target);
    cachePut(cacheKey, translated);
  }

  // Restore tag placeholders. Google sometimes adds spaces/case-changes inside brackets.
  translated = translated.replace(/\[\s*\[\s*TT\s*(\d+)\s*TT\s*\]\s*\]/gi, (_m, i) => {
    const idx = Number(i);
    return tags[idx] !== undefined ? tags[idx] : _m;
  });

  return translated;
}

// Translate a single short string (for inline keyboard button labels and
// callback-query toast text). Uses the same cache. Skips empty / lang=default.
async function translatePlain(text: string, target: string): Promise<string> {
  if (!text || !text.trim()) return text;
  const cacheKey = `${target}|btn|${text}`;
  const cached = translateCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const out = await googleTranslate(text, target);
  cachePut(cacheKey, out);
  return out;
}

export async function translateForUser(text: string, userId: number | undefined): Promise<string> {
  if (!text || userId === undefined) return text;
  const lang = await getUserLang(userId);
  if (lang === "default") return text;
  try {
    return await translateHtml(text, lang);
  } catch {
    return text;
  }
}

// ---------------- grammY API transformer ----------------

const TRANSLATABLE_METHODS = new Set([
  "sendMessage",
  "editMessageText",
  "sendPhoto",
  "sendDocument",
  "sendVideo",
  "sendAudio",
  "sendAnimation",
  "sendVoice",
  "editMessageCaption",
  "answerCallbackQuery",
]);

function extractUserId(payload: any): number | undefined {
  if (!payload) return undefined;
  if (typeof payload.chat_id === "number") return payload.chat_id;
  if (typeof payload.chat_id === "string") {
    const n = Number(payload.chat_id);
    if (Number.isFinite(n)) return n;
  }
  if (typeof payload.user_id === "number") return payload.user_id;
  // For answerCallbackQuery, we don't know the user from payload; the caller
  // wraps the text manually.
  return undefined;
}

// Methods that can carry a reply_markup with inline keyboard buttons.
const REPLY_MARKUP_METHODS = new Set([
  "sendMessage",
  "editMessageText",
  "editMessageReplyMarkup",
  "editMessageCaption",
  "sendPhoto",
  "sendDocument",
  "sendVideo",
  "sendAudio",
  "sendAnimation",
  "sendVoice",
]);

// Batches all uncached button labels into a SINGLE Google Translate request
// using a rare separator. Already-cached labels are reused. This turns N
// sequential HTTP calls into at most 1 — a huge speed-up for big keyboards.
const BATCH_SEP = "\n@@@SEP@@@\n";

async function translateBatch(texts: string[], lang: string): Promise<string[]> {
  if (texts.length === 0) return [];
  const result = new Array<string>(texts.length);
  const missingIdx: number[] = [];
  const missingTxt: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const key = `${lang}|btn|${t}`;
    const cached = translateCache.get(key);
    if (cached !== undefined) {
      result[i] = cached;
    } else if (!t || !t.trim()) {
      result[i] = t;
    } else {
      missingIdx.push(i);
      missingTxt.push(t);
    }
  }
  if (missingTxt.length > 0) {
    let translatedParts: string[];
    try {
      const joined = missingTxt.join(BATCH_SEP);
      const out = await googleTranslate(joined, lang);
      translatedParts = out.split(BATCH_SEP);
      // Fallback: if separator got mangled and counts don't match, fall back
      // to per-item translation in parallel.
      if (translatedParts.length !== missingTxt.length) {
        translatedParts = await Promise.all(
          missingTxt.map((t) => googleTranslate(t, lang).catch(() => t))
        );
      }
    } catch {
      translatedParts = await Promise.all(
        missingTxt.map((t) => googleTranslate(t, lang).catch(() => t))
      );
    }
    for (let j = 0; j < missingIdx.length; j++) {
      const i = missingIdx[j];
      const tr = (translatedParts[j] ?? missingTxt[j]).trim();
      result[i] = tr;
      cachePut(`${lang}|btn|${missingTxt[j]}`, tr);
    }
  }
  return result;
}

async function translateInlineKeyboard(rm: any, lang: string): Promise<any> {
  if (!rm || !Array.isArray(rm.inline_keyboard)) return rm;
  // Collect all button labels first.
  const labels: string[] = [];
  const positions: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < rm.inline_keyboard.length; r++) {
    const row = rm.inline_keyboard[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const btn = row[c];
      if (btn && typeof btn === "object" && typeof btn.text === "string") {
        labels.push(btn.text);
        positions.push({ r, c });
      }
    }
  }
  if (labels.length === 0) return rm;
  const translated = await translateBatch(labels, lang);
  const newRows: any[][] = rm.inline_keyboard.map((row: any) =>
    Array.isArray(row) ? row.slice() : row
  );
  for (let i = 0; i < positions.length; i++) {
    const { r, c } = positions[i];
    const btn = newRows[r][c];
    newRows[r][c] = { ...btn, text: translated[i] };
  }
  return { ...rm, inline_keyboard: newRows };
}

export function makeTranslateTransformer() {
  return async function translateTransformer(
    prev: (method: string, payload: any, signal?: AbortSignal) => Promise<any>,
    method: string,
    payload: any,
    signal?: AbortSignal
  ) {
    if ((TRANSLATABLE_METHODS.has(method) || REPLY_MARKUP_METHODS.has(method))
        && payload && typeof payload === "object") {
      const userId = extractUserId(payload);
      if (userId !== undefined) {
        const lang = await getUserLang(userId);
        if (lang !== "default") {
          const [textOut, captionOut, rmOut] = await Promise.all([
            typeof payload.text === "string"
              ? translateHtml(payload.text, lang).catch(() => payload.text)
              : Promise.resolve(payload.text),
            typeof payload.caption === "string"
              ? translateHtml(payload.caption, lang).catch(() => payload.caption)
              : Promise.resolve(payload.caption),
            payload.reply_markup && typeof payload.reply_markup === "object"
              ? translateInlineKeyboard(payload.reply_markup, lang).catch(() => payload.reply_markup)
              : Promise.resolve(payload.reply_markup),
          ]);
          payload = { ...payload };
          if (typeof textOut === "string") payload.text = textOut;
          if (typeof captionOut === "string") payload.caption = captionOut;
          if (rmOut !== undefined) payload.reply_markup = rmOut;
        }
      }
    }
    return prev(method, payload, signal);
  };
}

// ---------------- Localized strings for the /language UI ----------------

export const LANG_PROMPT: Record<LangCode, string> = {
  default:
    "🌐 <b>Language Settings</b>\n\nApni preferred language choose karo:\n\n<i>Default = English + Hindi (jo abhi hai waisa hi)</i>",
  en: "🌐 <b>Language Settings</b>\n\nChoose your preferred language:\n\n<i>Default keeps the bot's original mix of English &amp; Hindi.</i>",
  hi: "🌐 <b>भाषा सेटिंग्स</b>\n\nअपनी पसंदीदा भाषा चुनें:\n\n<i>Default = अंग्रेज़ी + हिन्दी (जैसा अभी है)</i>",
  id: "🌐 <b>Pengaturan Bahasa</b>\n\nPilih bahasa yang Anda inginkan:\n\n<i>Default mempertahankan campuran asli Bahasa Inggris &amp; Hindi.</i>",
  zh: "🌐 <b>语言设置</b>\n\n请选择您偏好的语言：\n\n<i>默认保留原始的英语和印地语混合。</i>",
};

export const LANG_CONFIRM: Record<LangCode, string> = {
  default: "✅ Language set to Default (English + Hindi). Bot ab original text use karega.",
  en: "✅ Language set to English. The bot will reply in English from now on.",
  hi: "✅ भाषा हिन्दी पर सेट हो गई। अब बॉट हिन्दी में जवाब देगा।",
  id: "✅ Bahasa diatur ke Bahasa Indonesia. Bot akan membalas dalam Bahasa Indonesia mulai sekarang.",
  zh: "✅ 语言已设置为中文。机器人现在将以中文回复。",
};
