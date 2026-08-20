import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

const API_KEYS: string[] = [
  process.env.GEMINI_API_KEY,
  process.env.backup_GEMINI_API_KEY || process.env.BACKUP_GEMINI_API_KEY
].filter((k): k is string => Boolean(k && k.trim()));

export const DAILY_LIMIT_PER_KEY = Number(process.env.DAILY_EXTRACTION_LIMIT || 1500);
export const keyCount = Math.max(API_KEYS.length, 1);

const USAGE_FILE = path.join(process.env.VERCEL ? '/tmp' : process.cwd(), '.noon-usage.json');

interface UsageState {
  date: string;
  used: number[];
  exhausted: boolean[];
}

const ptDateKey = (d: Date = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

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
    // first run or unreadable file
  }
  return emptyUsage();
}

let usage: UsageState = loadUsage();

function saveUsage() {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch {
    // non-fatal
  }
}

function ensureUsageFresh() {
  if (usage.date !== ptDateKey()) {
    usage = emptyUsage();
    saveUsage();
  }
}

export function nextQuotaReset(): Date {
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

export function remainingExtractions(): number {
  ensureUsageFresh();
  return usage.used.reduce(
    (sum, used, i) => sum + (usage.exhausted[i] ? 0 : Math.max(0, DAILY_LIMIT_PER_KEY - used)),
    0
  );
}

export function getUsagePayload() {
  return {
    remaining: remainingExtractions(),
    dailyLimit: DAILY_LIMIT_PER_KEY * keyCount,
    resetAtIso: nextQuotaReset().toISOString()
  };
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

export const isQuotaError = (s: string) =>
  s.includes('429') || s.includes('RESOURCE_EXHAUSTED') || /quota|exceeded|billing/i.test(s);

const isTransientError = (s: string) =>
  s.includes('503') ||
  s.includes('UNAVAILABLE') ||
  s.includes('500') ||
  s.includes('502') ||
  s.includes('504') ||
  /high demand|overloaded/i.test(s);

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

export async function extractArabicText(body: {
  fileData?: string;
  mimeType?: string;
  scriptFocus?: string;
}) {
  const startTime = Date.now();
  const { fileData, mimeType = 'image/jpeg', scriptFocus = 'auto' } = body;

  if (!fileData) {
    return {
      status: 400,
      json: {
        error: 'Missing fileData',
        message: 'Provide base64 image or PDF data in the fileData field.'
      }
    };
  }

  if (remainingExtractions() <= 0) {
    return {
      status: 429,
      json: {
        error: 'Daily limit reached',
        message: 'The daily extraction limit for this demo has been reached.',
        resetAtIso: nextQuotaReset().toISOString()
      }
    };
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

  try {
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
    return {
      status: 200,
      json: {
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
      }
    };
  } catch (err: any) {
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
      return {
        status: 429,
        json: {
          error: 'Daily limit reached',
          message: 'The daily extraction limit for this demo has been reached.',
          resetAtIso: nextQuotaReset().toISOString()
        }
      };
    }

    return {
      status: 500,
      json: {
        error: 'Extraction failed',
        message,
        processingTimeMs: Date.now() - startTime
      }
    };
  }
}
