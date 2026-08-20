import type { IncomingMessage, ServerResponse } from 'http';
import { getUsagePayload } from '../../lib/usage';

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify(getUsagePayload()));
}
