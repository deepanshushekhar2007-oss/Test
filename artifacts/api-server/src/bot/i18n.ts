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

function googleTranslate(text: string, target: string): Promise<string> {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      client: "gtx",
      sl: "auto",
      tl: target,
      dt: "t",
      q: text,
    });
    const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "*/*",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
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
    req.setTimeout(8000, () => {
      try {
        req.destroy();
      } catch {}
      resolve(text);
    });
  });
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

async function translateInlineKeyboard(rm: any, lang: string): Promise<any> {
  if (!rm || !Array.isArray(rm.inline_keyboard)) return rm;
  const newRows: any[][] = [];
  for (const row of rm.inline_keyboard) {
    if (!Array.isArray(row)) {
      newRows.push(row);
      continue;
    }
    const newRow: any[] = [];
    for (const btn of row) {
      if (btn && typeof btn === "object" && typeof btn.text === "string") {
        const translated = await translatePlain(btn.text, lang);
        newRow.push({ ...btn, text: translated });
      } else {
        newRow.push(btn);
      }
    }
    newRows.push(newRow);
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
          let next = payload;
          if (typeof next.text === "string") {
            next = { ...next, text: await translateHtml(next.text, lang) };
          }
          if (typeof next.caption === "string") {
            next = { ...next, caption: await translateHtml(next.caption, lang) };
          }
          if (next.reply_markup && typeof next.reply_markup === "object") {
            next = { ...next, reply_markup: await translateInlineKeyboard(next.reply_markup, lang) };
          }
          payload = next;
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
