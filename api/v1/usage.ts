import type { IncomingMessage, ServerResponse } from 'http';

const DAILY_LIMIT_PER_KEY = Number(process.env.DAILY_EXTRACTION_LIMIT || 1500);
const keyCount = Math.max(
  [process.env.GEMINI_API_KEY, process.env.backup_GEMINI_API_KEY || process.env.BACKUP_GEMINI_API_KEY].filter(
    (k) => Boolean(k && k.trim())
  ).length,
  1
);

function nextQuotaReset(): Date {
  const now = new Date();
  const offsetName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'longOffset'
  })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value;
  const offset = offsetName && offsetName.length > 3 ? offsetName.slice(3) : '-07:00';
  const date = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const midnightToday = new Date(`${date}T00:00:00${offset}`);
  return new Date(midnightToday.getTime() + 24 * 3600 * 1000);
}

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      remaining: DAILY_LIMIT_PER_KEY * keyCount,
      dailyLimit: DAILY_LIMIT_PER_KEY * keyCount,
      resetAtIso: nextQuotaReset().toISOString()
    })
  );
}
