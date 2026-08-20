import fs from 'fs';
import path from 'path';

export const DAILY_LIMIT_PER_KEY = Number(process.env.DAILY_EXTRACTION_LIMIT || 1500);

export const API_KEYS: string[] = [
  process.env.GEMINI_API_KEY,
  process.env.backup_GEMINI_API_KEY || process.env.BACKUP_GEMINI_API_KEY
].filter((k): k is string => Boolean(k && k.trim()));

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

export function ensureUsageFresh() {
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

export function recordSuccess(keyIdx: number) {
  ensureUsageFresh();
  usage.used[keyIdx] += 1;
  saveUsage();
}

export function recordExhausted(keyIdx: number) {
  ensureUsageFresh();
  usage.exhausted[keyIdx] = true;
  saveUsage();
}
