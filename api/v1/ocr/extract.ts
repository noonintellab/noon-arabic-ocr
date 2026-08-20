import type { IncomingMessage, ServerResponse } from 'http';
import { extractArabicText } from '../../../lib/ocr';

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const body = await readJson(req);
    const result = await extractArabicText(body);
    res.statusCode = result.status;
    res.end(JSON.stringify(result.json));
  } catch (err: any) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid request', message: err?.message || 'Could not parse body' }));
  }
}

export const config = {
  maxDuration: 60
};
