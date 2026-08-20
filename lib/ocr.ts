import { GoogleGenAI } from '@google/genai';
import {
  getApiKeys,
  getKeyCount,
  remainingExtractions,
  nextQuotaReset,
  recordSuccess,
  recordExhausted
} from './usage.js';

export { remainingExtractions, nextQuotaReset, getUsagePayload } from './usage.js';

let activeKeyIndex = 0;
const clientCache = new Map<number, GoogleGenAI>();

function getGenAI(keyIndex: number): GoogleGenAI {
  if (!clientCache.has(keyIndex)) {
    clientCache.set(
      keyIndex,
      new GoogleGenAI({
        apiKey: getApiKeys()[keyIndex] || 'dummy-key',
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

// A stalled key must not swallow the whole serverless budget, otherwise the
// platform kills the function before any fallback key is ever tried.
const ATTEMPT_TIMEOUT_MS = Number(process.env.GEMINI_ATTEMPT_TIMEOUT_MS || 20000);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function generateWithFailover(requestParams: { contents: any; config?: any }) {
  const models = ['gemini-3.7-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
  const keyCount = getKeyCount();
  let lastError: any = null;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let sawTransient = false;

      for (let k = 0; k < keyCount; k++) {
        const keyIdx = (activeKeyIndex + k) % keyCount;
        try {
          const response = await withTimeout(
            getGenAI(keyIdx).models.generateContent({
              model,
              contents: requestParams.contents,
              config: requestParams.config
            }),
            ATTEMPT_TIMEOUT_MS
          );
          if (keyIdx !== activeKeyIndex) {
            console.warn(`[Noon OCR] Switched to key #${keyIdx + 1}`);
            activeKeyIndex = keyIdx;
          }
          recordSuccess(keyIdx);
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
            recordExhausted(keyIdx);
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

  if (getApiKeys().length === 0) {
    return {
      status: 503,
      json: {
        error: 'Not configured',
        message: 'No Gemini API key is configured on the server.'
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
