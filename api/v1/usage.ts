import type { IncomingMessage, ServerResponse } from 'http';
import { getUsagePayload } from '../../lib/usage.js';

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(JSON.stringify(await getUsagePayload()));
}
