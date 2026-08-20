import { createHash } from 'crypto';
import { Redis } from '@upstash/redis';

export const DAILY_LIMIT_PER_KEY = Number(process.env.DAILY_EXTRACTION_LIMIT || 1500);

// Resolved on demand rather than at import time: under ESM the imports of this
// module are evaluated before dotenv.config() runs in the dev server, so reading
// process.env eagerly would capture an empty environment.
export function getApiKeys(): string[] {
  return [
    process.env.GEMINI_API_KEY,
    process.env.backup_GEMINI_API_KEY || process.env.BACKUP_GEMINI_API_KEY
  ].filter((k): k is string => Boolean(k && k.trim()));
}

export function getKeyCount(): number {
  return Math.max(getApiKeys().length, 1);
}

// Counters are filed under a digest of the key itself rather than its position,
// so swapping or reordering keys never makes one inherit another's tally.
function keyTag(keyIdx: number): string {
  const key = getApiKeys()[keyIdx];
  if (!key) return `slot${keyIdx}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

const ptDateKey = (d: Date = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

const bucketKey = () => `noon:usage:${ptDateKey()}`;
const BUCKET_TTL_SECONDS = 3 * 24 * 3600;

let redis: Redis | null = null;

// Every extraction runs in its own serverless invocation, so the counters have
// to live outside the process to be shared. Without a store configured the
// counters still work, but only for the lifetime of a single instance.
function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

interface Counters {
  used: number[];
  /** Keys that are out of quota or rejected, and so contribute nothing today. */
  exhausted: boolean[];
}

const memory = new Map<string, Counters>();

function memoryCounters(): Counters {
  const key = bucketKey();
  let entry = memory.get(key);
  if (!entry) {
    entry = { used: [], exhausted: [] };
    memory.clear();
    memory.set(key, entry);
  }
  while (entry.used.length < getKeyCount()) {
    entry.used.push(0);
    entry.exhausted.push(false);
  }
  return entry;
}

async function readCounters(): Promise<Counters> {
  const client = getRedis();
  if (!client) return memoryCounters();

  const raw = await client.hgetall<Record<string, string | number>>(bucketKey());
  const counters: Counters = { used: [], exhausted: [] };
  for (let i = 0; i < getKeyCount(); i++) {
    const tag = keyTag(i);
    counters.used.push(Number(raw?.[`used:${tag}`] ?? 0) || 0);
    counters.exhausted.push(String(raw?.[`exh:${tag}`] ?? '') === '1');
  }
  return counters;
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

export async function remainingExtractions(): Promise<number> {
  const { used, exhausted } = await readCounters();
  return used.reduce(
    (sum, count, i) => sum + (exhausted[i] ? 0 : Math.max(0, DAILY_LIMIT_PER_KEY - count)),
    0
  );
}

export async function getUsagePayload() {
  return {
    remaining: await remainingExtractions(),
    dailyLimit: DAILY_LIMIT_PER_KEY * getKeyCount(),
    resetAtIso: nextQuotaReset().toISOString()
  };
}

// Quota is enforced per model, so a key rejected by one model may still serve
// another. Any success clears the flag again.
export async function recordSuccess(keyIdx: number): Promise<void> {
  const client = getRedis();
  if (!client) {
    const counters = memoryCounters();
    counters.used[keyIdx] += 1;
    counters.exhausted[keyIdx] = false;
    return;
  }
  const key = bucketKey();
  const tag = keyTag(keyIdx);
  await client.hincrby(key, `used:${tag}`, 1);
  await client.hdel(key, `exh:${tag}`);
  await client.expire(key, BUCKET_TTL_SECONDS);
}

export async function recordExhausted(keyIdx: number): Promise<void> {
  const client = getRedis();
  if (!client) {
    memoryCounters().exhausted[keyIdx] = true;
    return;
  }
  const key = bucketKey();
  await client.hset(key, { [`exh:${keyTag(keyIdx)}`]: '1' });
  await client.expire(key, BUCKET_TTL_SECONDS);
}
