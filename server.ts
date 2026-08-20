import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

// Gemini API keys. Additional keys act as spare capacity: when one is out of
// daily quota (or fails auth) the next one takes over transparently.
const API_KEYS: string[] = [
  process.env.GEMINI_API_KEY,
  process.env.backup_GEMINI_API_KEY || process.env.BACKUP_GEMINI_API_KEY
].filter((k): k is string => Boolean(k && k.trim()));

if (API_KEYS.length === 0) {
  console.warn('[Noon OCR] No GEMINI_API_KEY set. Extraction will fail until one is configured.');
} else {
  console.log(`[Noon OCR] ${API_KEYS.length} API key(s) loaded`);
}

// ---- Daily capacity tracking ----
// Free-tier quotas are counted per key and reset at midnight Pacific time.
// Externally we only ever expose one combined number of remaining extractions.
const USAGE_FILE = path.join(process.env.VERCEL ? '/tmp' : process.cwd(), '.noon-usage.json');
const DAILY_LIMIT_PER_KEY = Number(process.env.DAILY_EXTRACTION_LIMIT || 1500);

interface UsageState {
  date: string;
  used: number[];
  exhausted: boolean[];
}

const ptDateKey = (d: Date = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

const keyCount = Math.max(API_KEYS.length, 1);

const emptyUsage = (): UsageState => ({
  date: ptDateKey(),
  used: Array(keyCount).fill(0),
  exhausted: Array(keyCount).fill(false)
});

function loadUsage(): UsageState {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    if (raw?.date === ptDateKey() && Array.isArray(raw.used)) {
      const fresh = emptyUsage();
      raw.used.slice(0, keyCount).forEach((n: number, i: number) => (fresh.used[i] = Number(n) || 0));
      (raw.exhausted || []).slice(0, keyCount).forEach((b: boolean, i: number) => (fresh.exhausted[i] = !!b));
      return fresh;
    }
  } catch {
    // first run or unreadable file — start fresh
  }
  return emptyUsage();
}

let usage: UsageState = loadUsage();

function saveUsage() {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch {
    // non-fatal: the counter is a convenience, not a source of truth
  }
}

function ensureUsageFresh() {
  if (usage.date !== ptDateKey()) {
    usage = emptyUsage();
    saveUsage();
  }
}

// Free-tier daily quotas reset at midnight Pacific time
function nextQuotaReset(): Date {
  const now = new Date();
  const offsetName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'longOffset'
  })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value;
  const offset = offsetName && offsetName.length > 3 ? offsetName.slice(3) : '-07:00';
  const midnightToday = new Date(`${ptDateKey(now)}T00:00:00${offset}`);
  return new Date(midnightToday.getTime() + 24 * 3600 * 1000);
}

function remainingExtractions(): number {
  ensureUsageFresh();
  return usage.used.reduce(
    (sum, used, i) => sum + (usage.exhausted[i] ? 0 : Math.max(0, DAILY_LIMIT_PER_KEY - used)),
    0
  );
}

let activeKeyIndex = 0;
const clientCache = new Map<number, GoogleGenAI>();

function getGenAI(keyIndex: number): GoogleGenAI {
  if (!clientCache.has(keyIndex)) {
    clientCache.set(
      keyIndex,
      new GoogleGenAI({
        apiKey: API_KEYS[keyIndex] || 'dummy-key',
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      })
    );
  }
  return clientCache.get(keyIndex)!;
}

const isQuotaError = (s: string) =>
  s.includes('429') || s.includes('RESOURCE_EXHAUSTED') || /quota|exceeded|billing/i.test(s);

const isTransientError = (s: string) =>
  s.includes('503') ||
  s.includes('UNAVAILABLE') ||
  s.includes('500') ||
  s.includes('502') ||
  s.includes('504') ||
  /high demand|overloaded/i.test(s);

// Runs a vision request, rotating across keys when one is exhausted or rejected,
// and falling back to lighter models during traffic spikes.
async function generateWithFailover(requestParams: { contents: any; config?: any }) {
  const models = ['gemini-3.7-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
  let lastError: any = null;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let sawTransient = false;

      for (let k = 0; k < keyCount; k++) {
        const keyIdx = (activeKeyIndex + k) % keyCount;
        try {
          const response = await getGenAI(keyIdx).models.generateContent({
            model,
            contents: requestParams.contents,
            config: requestParams.config
          });
          if (keyIdx !== activeKeyIndex) {
            console.warn(`[Noon OCR] Switched to key #${keyIdx + 1}`);
            activeKeyIndex = keyIdx;
          }
          ensureUsageFresh();
          usage.used[keyIdx] += 1;
          saveUsage();
          return { response, modelUsed: model };
        } catch (err: any) {
          lastError = err;
          const msg = String(err?.message || JSON.stringify(err) || '');
          console.warn(`[Noon OCR] ${model} / key#${keyIdx + 1} / attempt ${attempt + 1}: ${msg.slice(0, 140)}`);

          if (/thinking/i.test(msg) && requestParams.config?.thinkingConfig) {
            delete requestParams.config.thinkingConfig;
            k--;
            continue;
          }
          if (isQuotaError(msg)) {
            ensureUsageFresh();
            usage.exhausted[keyIdx] = true;
            saveUsage();
          } else if (isTransientError(msg)) {
            sawTransient = true;
          }
        }
      }

      if (sawTransient && attempt === 0) {
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 400));
        continue;
      }
      break;
    }
  }

  throw lastError;
}

export async function createApp() {
  const app = express();

  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Vercel may rewrite /api/* onto this function with the /api prefix stripped.
  app.use((req, _res, next) => {
    if (req.url?.startsWith('/v1/') || req.url === '/health' || req.url?.startsWith('/health?')) {
      req.url = `/api${req.url}`;
    }
    next();
  });

  // Demo documents: Vite copies public/samples; locally we also serve ./samples
  app.use('/samples', express.static(path.join(process.cwd(), 'public', 'samples'), { maxAge: '1h' }));
  app.use('/samples', express.static(path.join(process.cwd(), 'samples'), { maxAge: '1h' }));

  app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', service: 'Noon Arabic OCR', timestamp: new Date().toISOString() });
  });

  // Remaining extractions for today (single combined figure)
  app.get('/api/v1/usage', (req, res) => {
    const remaining = remainingExtractions();
    res.json({
      remaining,
      dailyLimit: DAILY_LIMIT_PER_KEY * keyCount,
      resetAtIso: nextQuotaReset().toISOString()
    });
  });

  // Arabic text extraction (vision)
  app.post('/api/v1/ocr/extract', async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
      const { fileData, mimeType = 'image/jpeg', scriptFocus = 'auto' } = req.body;

      if (!fileData) {
        return res.status(400).json({
          error: 'Missing fileData',
          message: 'Provide base64 image or PDF data in the fileData field.'
        });
      }

      if (remainingExtractions() <= 0) {
        const resetAt = nextQuotaReset();
        return res.status(429).json({
          error: 'Daily limit reached',
          message: 'The daily extraction limit for this demo has been reached.',
          resetAtIso: resetAt.toISOString()
        });
      }

      const cleanBase64 = fileData.replace(/^data:[^;]+;base64,/, '');

      const systemInstruction = `You are Noon OCR, a high-precision Arabic OCR engine for handwriting and print.
Transcribe the text exactly as written. Disambiguate Arabic letter dots carefully (ب ت ث ن ي / ج ح خ / د ذ / ر ز / س ش / ص ض / ط ظ / ع غ / ف ق), keep the correct right-to-left reading order and the original line breaks, and reproduce Eastern (٠١٢٣٤٥٦٧٨٩) or Western numerals exactly as they appear. Preserve any diacritics (tashkeel) exactly as written — never add or remove them.${
        scriptFocus && scriptFocus !== 'auto' ? ` Expected script: ${scriptFocus}.` : ''
      }
Do not translate, summarise, explain, or add anything that is not in the document.
Return ONLY a JSON object with exactly these fields:
{
  "primaryScript": "islamic_script"|"naskh"|"diwani"|"thuluth"|"kufic"|"modern_handwriting"|"printed_standard"|"mixed",
  "documentCategory": "handwritten_note"|"invoice_receipt"|"medical_prescription"|"legal_contract"|"id_official_doc"|"historical_manuscript"|"general_document",
  "language": "ar"|"ar-en"|"ar-fr"|"multilingual",
  "overallConfidence": number 0-100 (honest transcription confidence),
  "fullTextArabic": string (the complete transcription, preserving line breaks)
}`;

      const { response } = await generateWithFailover({
        contents: {
          parts: [
            { inlineData: { mimeType: mimeType || 'image/jpeg', data: cleanBase64 } },
            { text: 'Transcribe the text in this document.' }
          ]
        },
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 0 }
        }
      });

      const rawText = response.text?.trim() || '{}';
      let parsed: any = {};
      try {
        parsed = JSON.parse(rawText);
      } catch {
        const match = rawText.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : { fullTextArabic: rawText };
      }

      const fullText: string = parsed.fullTextArabic || '';

      res.json({
        documentId: `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        processingTimeMs: Date.now() - startTime,
        primaryScript: parsed.primaryScript || 'printed_standard',
        documentCategory: parsed.documentCategory || 'general_document',
        language: parsed.language || 'ar',
        overallConfidence: parsed.overallConfidence ?? 90,
        fullTextArabic: fullText,
        metadata: {
          charCount: fullText.length,
          wordCount: fullText ? fullText.split(/\s+/).filter(Boolean).length : 0
        },
        remaining: remainingExtractions()
      });
    } catch (err: any) {
      console.error('[Noon OCR] Extraction error:', err?.message || err);

      let message = 'An unexpected error occurred while reading the document.';
      if (err?.message) {
        try {
          const parsed = JSON.parse(err.message);
          message = parsed?.error?.message || err.message;
        } catch {
          message = err.message;
        }
      }

      if (isQuotaError(message)) {
        return res.status(429).json({
          error: 'Daily limit reached',
          message: 'The daily extraction limit for this demo has been reached.',
          resetAtIso: nextQuotaReset().toISOString()
        });
      }

      res.status(500).json({
        error: 'Extraction failed',
        message,
        processingTimeMs: Date.now() - startTime
      });
    }
  });

  // On Vercel the frontend is served as static files; the function only handles /api.
  if (!process.env.VERCEL) {
    if (process.env.NODE_ENV !== 'production') {
      const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
      app.use(vite.middlewares);
    } else {
      const distPath = path.join(process.cwd(), 'dist');
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  return app;
}

if (!process.env.VERCEL) {
  createApp()
    .then((app) => {
      const PORT = Number(process.env.PORT) || 3000;
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`Noon Arabic OCR running on http://0.0.0.0:${PORT}`);
      });
    })
    .catch(console.error);
}
