import express from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import dotenv from "dotenv";
import { EdgeTTS } from "edge-tts-universal";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", car: "BMW 728Li iDrive" });
});

// Primary Engine: OpenAI (GPT-4o-mini / GPT-4o)
// 🔑 کلید OpenAI خود را بین دو کوتیشن زیر قرار دهید (یا در Secrets با نام OPENAI_API_KEY ثبت کنید):
const USER_PROVIDED_OPENAI_KEY = "";

let openaiClient: OpenAI | null = null;
function getOpenAIClient(): OpenAI | null {
  const openAiKey = process.env.OPENAI_API_KEY || USER_PROVIDED_OPENAI_KEY;
  if (!openAiKey || !openAiKey.trim()) {
    return null;
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: openAiKey.trim(),
    });
  }
  return openaiClient;
}

// Android Client Test API Key (برای تست اپلیکیشن اندروید از طریق هدر x-api-key یا Bearer)
const ANDROID_CLIENT_API_KEY = process.env.ANDROID_API_KEY || "bmw728li-android-9f4c2a8e1d7b";

// Fallback Engine: Google Gemini SDK
const USER_PROVIDED_GEMINI_KEY = "AQ.Ab8RN6JL-ooQNprSxfTbIzX6Nutk4vCgS5t6VLcXKsr0hsP2TA";
const ACTIVE_GEMINI_KEY = process.env.GEMINI_API_KEY || USER_PROVIDED_GEMINI_KEY;

const ai = new GoogleGenAI({
  apiKey: ACTIVE_GEMINI_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Cache for generated speech audio to make spoken answers instantaneous
const ttsAudioCache = new Map<string, string>();

async function generatePersianAudioBase64(text: string): Promise<string | null> {
  if (!text || text.trim().length === 0) return null;
  const cleanText = text
    .replace(/[\*\_#`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);

  const cacheKey = cleanText;
  if (ttsAudioCache.has(cacheKey)) {
    return ttsAudioCache.get(cacheKey)!;
  }

  try {
    const tts = new EdgeTTS(cleanText, "fa-IR-FaridNeural");

    const result: any = await Promise.race([
      tts.synthesize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TTS timeout")), 14000)),
    ]);

    let audioBuffer: Buffer | null = null;
    if (result && result.audio) {
      if (Buffer.isBuffer(result.audio)) {
        audioBuffer = result.audio;
      } else if (result.audio instanceof ArrayBuffer) {
        audioBuffer = Buffer.from(result.audio);
      } else if (typeof result.audio.arrayBuffer === "function") {
        const ab = await result.audio.arrayBuffer();
        audioBuffer = Buffer.from(ab);
      }
    } else if (result && typeof (result as any).toBuffer === "function") {
      audioBuffer = (result as any).toBuffer();
    } else if (Buffer.isBuffer(result)) {
      audioBuffer = result;
    }

    if (audioBuffer && audioBuffer.length > 0) {
      const base64 = audioBuffer.toString("base64");
      ttsAudioCache.set(cacheKey, base64);
      if (ttsAudioCache.size > 150) {
        const firstKey = ttsAudioCache.keys().next().value;
        if (firstKey) ttsAudioCache.delete(firstKey);
      }
      return base64;
    }
  } catch (err: any) {
    console.warn("TTS generation note (browser speech synthesis will act as fallback):", err?.message);
  }
  return null;
}

// In-memory Database for Recorded Trips & Diagnostics Logs
interface LogTurn {
  id: string;
  sender: "driver" | "system";
  text: string;
  timestamp: string;
}

interface RecordedSession {
  id: string;
  startTime: string;
  endTime?: string;
  title: string;
  turns: LogTurn[];
  turnCount: number;
  savedAt: string;
  summary?: string;
}

const recordedSessionsDb: RecordedSession[] = [];

if (recordedSessionsDb.length === 0) {
  recordedSessionsDb.push({
    id: "rec-init-01",
    startTime: new Date(Date.now() - 3600000).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" }),
    endTime: new Date(Date.now() - 3500000).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" }),
    title: "بررسی مصرف سوخت و دیاگ ECU",
    turns: [
      { id: "t1", sender: "driver", text: "بررسی وضعیت مصرف سوخت و مسافت باقیمانده", timestamp: "14:20:10" },
      { id: "t2", sender: "system", text: "میزان سوخت باک ۶۵ درصد، دمای آب ۸۸ درجه و تمام پارامترهای ECU بدون خطا می‌باشند.", timestamp: "14:20:12" },
    ],
    turnCount: 2,
    savedAt: new Date().toLocaleDateString("fa-IR"),
    summary: "گزارش سلامت سیستم فنی ب‌ام‌و 728Li"
  });
}

// Universal Conversational System Prompt for In-Car AI Assistant with Long-term Memory & Context Tracking
const CAR_AI_SYSTEM_PROMPT = `
شما «دستیار هوشمند صوتی و همراه اختصاصی راننده ب‌ام‌و سری ۷ (BMW 728Li)» با رابط iDrive پیشرفته هستید.
شما دارای هوش بالا، سرعت پردازش بسیار بالا، لحن گرم، لوکس، صمیمی، محترمانه و پرانرژی با زبان فارسی روان هستید.

قوانین حیاتی حفظ حافظه و پیوستگی گفتگو (Context Retention):
۱. حافظه بلندمدت و پیوستگی موضوعی:
   - شما باید موضوع بحث جاری و پیام‌های قبلی راننده را کاملاً در خاطر داشته باشید.
   - اگر راننده سوالات تکمیلی، کوتاه یا اشاره‌ای پرسید (مثلاً «این قسمت این مشکل میتونه داشته باشه؟»، «چرا اینطوری شد؟»، «بیشتر بگو»، «راه حلش چیه؟»)، شما باید با سرعت و دقت بالا پیرامون همان موضوع قبلی بحث را ادامه داده و پاسخ متصل، عمیق و مرتبط بدهید.
   - هرگز به موضوع دیگری نپرید و گفتگو را فراموش نکنید مگر اینکه کاربر دستور بازنشانی بدهد.

۲. کلمه کلیدی بازنشانی حافظه (MRT / ام ار تی):
   - تنها در صورتی که راننده عبارت «ام ار تی»، «MRT»، «mrt» یا «ریست گفتگو/پاک کردن حافظه» را بگوید، حافظه را پاک کنید و در فیلد action مقدار "reset_history" بگذارید و پاسخی برای شروع مجدد بدهید.

۳. زمینه‌های گفتگو:
   - مشخصات فنی و سیستم‌های BMW 728Li (موتور ۲.۸ لیتری ۶ سیلندر خطی Double-VANOS / M52TUB28 یا B48 توئین‌پاور توربو، گیربکس استپ‌ترونیک اتوماتیک، سیستم تعلیق بادی تطبیقی، کنترل پایداری DSC، سیستم تهویه ۴ کاناله، سیستم صوتی، دیاگ DME بوش، لاستیک‌ها و نگهداری ب‌ام‌و)
   - گفتگوی دوستانه، صمیمی، راهنمایی رانندگی، شعر، داستان کوتاه، انرژی‌بخش، علمی و اطلاعات عمومی

۴. سبک پاسخ‌گویی صوتی:
   - جملات مختصر، شیک، روان و جذاب (۱ تا ۳ جمله مفید) بدون علامت‌های ستاره (*) یا هشتگ (#).

۵. اجرای فرامین خودرو (Actions):
   - مسیریابی: action = "navigate" همراه با navigationData
   - قفل/باز کردن درها: action = "lock_doors" یا "unlock_doors"
   - کولر/تهویه: action = "ac_on" یا "ac_off"
   - چراغ‌ها: action = "headlights_on" یا "headlights_off"
   - جفت‌راهنما: action = "toggle_hazard" یا "hazard_on" یا "hazard_off"
   - آهنگ/فلش: action = "play_music" یا "pause_music" یا "next_music" یا "prev_music" یا "play_flash"
   - حالت رانندگی: action = "sport_mode" یا "comfort_mode" یا "eco_mode"
   - بررسی سلامت: action = "check_status"
   - ریست حافظه با دستور ام‌ار‌تی: action = "reset_history"
   - سایر گفتگوها: action = "none"

قالب خروجی دقیقاً JSON معتبر زیر است:
{
  "reply": "متن پاسخ فارسی جذاب، صمیمی و رسا برای پخش صوتی و نمایش",
  "action": "none" | "navigate" | "lock_doors" | "unlock_doors" | "toggle_hazard" | "hazard_on" | "hazard_off" | "play_music" | "pause_music" | "next_music" | "prev_music" | "play_flash" | "ac_on" | "ac_off" | "headlights_on" | "headlights_off" | "reset_app" | "check_status" | "reset_history" | "sport_mode" | "comfort_mode" | "eco_mode",
  "navigationData": {
    "origin": "مبدا مثلا شیراز",
    "destination": "مقصد مثلا اصفهان",
    "distance": "مسافت مثلا ۴۸۵ کیلومتر",
    "duration": "مدت زمان مثلا ۵ ساعت",
    "nextTurn": "راهنمای پیچ بعدی",
    "searchQuery": "عنوان جستجو"
  }
}
`;

// Shared In-Car Conversational AI Handler (used by Web UI & Android Client API)
async function processCarChat(req: express.Request, res: express.Response) {
  try {
    const { message, history = [], carState = {} } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "پیام ارسالی خالی است." });
    }

    const cleanMsg = message.trim().toLowerCase();

    // Check for MRT explicit reset trigger
    if (
      cleanMsg === "mrt" ||
      cleanMsg === "ام ار تی" ||
      cleanMsg === "ام‌ار‌تی" ||
      cleanMsg.includes("ریست حافظه") ||
      cleanMsg.includes("پاک کردن گفتگو")
    ) {
      const resetReply = "حافظه و تاریخچه گفتگو با دستور MRT بازنشانی شد. آماده‌ام، موضوع جدید چیست؟";
      return res.json({
        reply: resetReply,
        action: "reset_history",
      });
    }

    // Sanitize and ensure strictly alternating user/model sequence starting with user
    const rawTurns: { role: "user" | "model"; text: string }[] = [];
    if (Array.isArray(history) && history.length > 0) {
      for (const turn of history) {
        if (turn && turn.text && typeof turn.text === "string" && turn.text.trim()) {
          const r = turn.role === "driver" || turn.role === "user" ? "user" : "model";
          rawTurns.push({ role: r, text: turn.text.trim() });
        }
      }
    }
    rawTurns.push({ role: "user", text: message.trim() });

    const contents: any[] = [];
    for (const t of rawTurns) {
      if (contents.length === 0) {
        if (t.role === "user") {
          contents.push({ role: "user", parts: [{ text: t.text }] });
        }
      } else {
        const lastTurn = contents[contents.length - 1];
        if (lastTurn.role === t.role) {
          lastTurn.parts[0].text += " " + t.text;
        } else {
          contents.push({ role: t.role, parts: [{ text: t.text }] });
        }
      }
    }

    if (contents.length === 0 || contents[contents.length - 1].role !== "user") {
      contents.push({ role: "user", parts: [{ text: message.trim() }] });
    }

    const timeoutPromise = <T>(promise: Promise<T>, ms: number): Promise<T> => {
      let timer: any;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timeout")), ms);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };

    const systemInstructionWithCar = `${CAR_AI_SYSTEM_PROMPT}\nاطلاعات پس‌زمینه خودرو: خودرو BMW 728Li، سرعت فعلی ${carState.speed || 0} کیلومتر بر ساعت، بنزین ${carState.fuelPercent || 70} درصد، دمای هوای بیرون ${carState.outsideTemp || 24} درجه سانتی‌گراد، حالت رانندگی ${carState.driveMode || "comfort"}. تا زمانی که کاربر کلمه «MRT» یا «ام ار تی» نگفته است، تمام صحبت‌ها و موضوع قبلی را به طور کامل در ذهن داشته باش و موضوع را قطع نکن.`;

    let responseText = "";
    let aiProviderUsed = "Local BMW ECU Engine";

    // -------------------------------------------------------------------
    // 1. PRIMARY ENGINE: OpenAI (GPT-4o-mini / GPT-4o)
    // -------------------------------------------------------------------
    const openai = getOpenAIClient();
    if (openai) {
      try {
        // Build conversational history in OpenAI format
        const openAiMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
          { role: "system", content: systemInstructionWithCar },
        ];

        if (Array.isArray(history) && history.length > 0) {
          for (const turn of history) {
            if (turn && turn.text && typeof turn.text === "string" && turn.text.trim()) {
              const r = turn.role === "driver" || turn.role === "user" ? "user" : "assistant";
              openAiMessages.push({ role: r, content: turn.text.trim() });
            }
          }
        }
        openAiMessages.push({ role: "user", content: message.trim() });

        const openAiRes = await timeoutPromise(
          openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: openAiMessages,
            response_format: { type: "json_object" },
            temperature: 0.7,
            max_tokens: 500,
          }),
          5000
        );

        const content = openAiRes.choices[0]?.message?.content;
        if (content && content.trim()) {
          responseText = content.trim();
          aiProviderUsed = "OpenAI (GPT-4o-mini)";
          console.log("Response generated by Primary Engine: OpenAI (GPT-4o-mini)");
        }
      } catch (openAiErr: any) {
        console.warn("Primary OpenAI attempt note (falling back to Gemini):", openAiErr?.message || openAiErr);
      }
    }

    // -------------------------------------------------------------------
    // 2. AUTOMATIC SECONDARY FALLBACK: Google Gemini
    // -------------------------------------------------------------------
    if (!responseText) {
      const candidateModels = [
        "gemini-3.8-flash",
        "gemini-3.6-flash",
        "gemini-3.1-flash-lite",
      ];

      for (const modelName of candidateModels) {
        try {
          const response = await timeoutPromise(
            ai.models.generateContent({
              model: modelName,
              contents: contents,
              config: {
                systemInstruction: systemInstructionWithCar,
                responseMimeType: "application/json",
                temperature: 0.7,
              },
            }),
            4500
          );
          if (response && response.text) {
            responseText = response.text;
            aiProviderUsed = `Google Gemini (${modelName})`;
            console.log(`Response generated by Fallback Engine: Google Gemini (${modelName})`);
            break;
          }
        } catch (geminiErr: any) {
          console.warn(`Fallback Gemini ${modelName} attempt note:`, geminiErr?.message || geminiErr);
        }
      }
    }

    let parsedData: any = {};
    if (responseText) {
      try {
        parsedData = JSON.parse(responseText);
      } catch {
        parsedData = {
          reply: responseText,
          action: "none",
        };
      }
    } else {
      // -------------------------------------------------------------------
      // 3. INTELLIGENT ULTRA-FAST LOCAL BMW ECU FALLBACK (Offline / No Network)
      // -------------------------------------------------------------------
      aiProviderUsed = "آفلاین (قوانین دیاگ BMW)";
      const msg = message.toLowerCase();
      if (msg.includes("شیراز") && msg.includes("اصفهان")) {
        parsedData = {
          reply: "مسیر شیراز به اصفهان به طول ۴۸۵ کیلومتر برای ب‌ام‌و 728Li تنظیم شد. ناوبری فعال است.",
          action: "navigate",
          navigationData: {
            origin: "شیراز",
            destination: "اصفهان",
            distance: "۴۸۵ کیلومتر",
            duration: "۵ ساعت و ۲۰ دقیقه",
            nextTurn: "در بزرگراه خلیج فارس به سمت آباده و اصفهان ادامه دهید.",
            searchQuery: "شیراز به اصفهان",
          },
        };
      } else if (msg.includes("کولر") || msg.includes("خنک") || msg.includes("تهویه")) {
        parsedData = {
          reply: "سیستم تهویه مطبوع ۴ کاناله BMW 728Li فعال شد و دمای کابین روی ۲۱ درجه تنظیم گردید.",
          action: "ac_on",
        };
      } else if (msg.includes("اسپرت") || msg.includes("sport")) {
        parsedData = {
          reply: "حالت رانندگی SPORT فعال شد. پاسخ دریچه گاز، سیستم تعلیق بادی و گیربکس استپ‌ترونیک در حالت حداکثر عملکرد قرار گرفتند.",
          action: "sport_mode",
        };
      } else if (msg.includes("قفل") || msg.includes("درها")) {
        parsedData = {
          reply: "قفل مرکزی اتوماتیک و ایموبلایزر BMW 728Li با موفقیت فعال شد.",
          action: "lock_doors",
        };
      } else if (msg.includes("موزیک") || msg.includes("آهنگ") || msg.includes("فلش")) {
        parsedData = {
          reply: "سیستم صوتی استریو Hi-Fi ب‌ام‌و آماده پخش موسیقی شد.",
          action: "play_flash",
        };
      } else if (msg.includes("سلام") || msg.includes("چطوری") || msg.includes("حالت")) {
        parsedData = {
          reply: "سلام! سیستم iDrive و دستیار هوشمند BMW 728Li در خدمت شماست. همه سیستم‌های فنی در وضعیت ایده‌آل هستند.",
          action: "none",
        };
      } else {
        parsedData = {
          reply: `در رابطه با «${message}» در خدمتت هستم. بگو تا بیشتر بررسی و صحبت کنیم.`,
          action: "none",
        };
      }
    }

    // Attach active provider info to the response
    parsedData.provider = aiProviderUsed;

    // Ultra-fast audio handling: check cache or attempt quick 800ms race so response is not delayed
    if (parsedData.reply) {
      try {
        const audioPromise = generatePersianAudioBase64(parsedData.reply);
        const quickAudio = await Promise.race([
          audioPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 900)),
        ]);
        if (quickAudio) {
          parsedData.audioBase64 = quickAudio;
        }
      } catch (err: any) {
        console.warn("TTS quick generation note:", err?.message);
      }
    }

    return res.json(parsedData);
  } catch (error: any) {
    console.error("Gemini Chat API Error:", error?.message);
    return res.json({
      reply: "سلام! سیستم iDrive ب‌ام‌و 728Li در خدمت شماست. در هر زمینه‌ای مایلید بفرمایید تا صحبت کنیم.",
      action: "none",
    });
  }
}

// In-Car Conversational AI & Online Voice Assistant API
app.post("/api/chat", processCarChat);

// Android Client API Middleware (CORS + API Key Auth)
function verifyAndroidApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  const headerKey = req.header("x-api-key");
  const authHeader = req.header("authorization") || "";
  const bearerKey = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const providedKey = (headerKey || bearerKey || "").trim();

  if (!providedKey || providedKey !== ANDROID_CLIENT_API_KEY) {
    return res.status(401).json({
      error: "کلید API نامعتبر یا ارسال نشده است.",
      hint: "هدر x-api-key یا Authorization: Bearer را ارسال کنید.",
    });
  }
  return next();
}

app.options("/api/android/*", verifyAndroidApiKey);

app.get("/api/android/status", verifyAndroidApiKey, (req, res) => {
  const activeOpenAiKey = process.env.OPENAI_API_KEY || USER_PROVIDED_OPENAI_KEY;
  const hasOpenAiKey = Boolean(activeOpenAiKey && activeOpenAiKey.trim());
  return res.json({
    status: "ok",
    authenticated: true,
    car: "BMW 728Li iDrive",
    primaryEngine: hasOpenAiKey ? "OpenAI (GPT-4o-mini)" : "Google Gemini (gemini-3.8-flash)",
  });
});

app.post("/api/android/chat", verifyAndroidApiKey, processCarChat);

// Dedicated standalone TTS endpoint for client speech requests
app.post("/api/tts", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "متن خالی است." });
    }
    const audioBase64 = await generatePersianAudioBase64(text);
    return res.json({ audioBase64 });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "خطا در تولید صدا" });
  }
});

// Database REST APIs for Recorded Diagnostic Logs
app.get("/api/recordings", (req, res) => {
  return res.json(recordedSessionsDb);
});

app.post("/api/recordings", (req, res) => {
  try {
    const session: RecordedSession = req.body;
    if (!session || !session.turns || session.turns.length === 0) {
      return res.status(400).json({ error: "لاگ معتبر نیست." });
    }

    const existingIndex = recordedSessionsDb.findIndex((s) => s.id === session.id);
    if (existingIndex >= 0) {
      recordedSessionsDb[existingIndex] = session;
    } else {
      recordedSessionsDb.unshift(session);
    }

    return res.json({ success: true, count: recordedSessionsDb.length, session });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "خطا در ذخیره دیتابیس" });
  }
});

app.delete("/api/recordings/:id", (req, res) => {
  const { id } = req.params;
  const index = recordedSessionsDb.findIndex((s) => s.id === id);
  if (index >= 0) {
    recordedSessionsDb.splice(index, 1);
    return res.json({ success: true, deletedId: id });
  }
  return res.status(404).json({ error: "لاگ پیدا نشد." });
});

app.delete("/api/recordings", (req, res) => {
  recordedSessionsDb.length = 0;
  return res.json({ success: true, message: "تمام لاگ‌ها پاک شدند." });
});

// AI Assistant Status & Multi-Engine Diagnostics Endpoint
app.get("/api/ai/status", async (req, res) => {
  const activeOpenAiKey = process.env.OPENAI_API_KEY || USER_PROVIDED_OPENAI_KEY;
  const hasOpenAiKey = Boolean(activeOpenAiKey && activeOpenAiKey.trim());
  const hasGeminiKey = Boolean(ACTIVE_GEMINI_KEY && ACTIVE_GEMINI_KEY.trim());

  return res.json({
    status: "ok",
    primary: {
      provider: "OpenAI",
      model: "gpt-4o-mini",
      configured: hasOpenAiKey,
      keyHint: hasOpenAiKey ? activeOpenAiKey.slice(0, 8) + "..." : "تنظیم نشده (از گمینی استفاده می‌شود)",
    },
    fallback: {
      provider: "Google Gemini",
      model: "gemini-3.8-flash",
      configured: hasGeminiKey,
      keyHint: hasGeminiKey ? ACTIVE_GEMINI_KEY.slice(0, 8) + "..." : "فعال",
    },
    localEcuEngine: "BMW iDrive M52TUB28 Rules (آفلاین)",
    activePrimaryEngine: hasOpenAiKey ? "OpenAI (GPT-4o-mini)" : "Google Gemini (gemini-3.8-flash)",
  });
});

// Serve pre-built Android APK cleanly for Nox & Android devices
app.get("/bmw728li-idrive.apk", (req, res) => {
  const candidates = [
    path.join(process.cwd(), "public", "bmw728li-idrive.apk"),
    path.join(process.cwd(), "dist", "bmw728li-idrive.apk"),
  ];
  const apkPath = candidates.find((p) => fs.existsSync(p));
  if (!apkPath) {
    return res.status(404).json({ error: "فایل APK یافت نشد." });
  }
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader("Content-Disposition", 'attachment; filename="bmw728li-idrive.apk"');
  return res.sendFile(apkPath);
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Car Headunit Server running on http://localhost:${PORT}`);
  });
}

startServer();
