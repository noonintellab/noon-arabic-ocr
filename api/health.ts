import type { IncomingMessage, ServerResponse } from 'http';

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      status: 'healthy',
      service: 'Noon Arabic OCR',
      timestamp: new Date().toISOString()
    })
  );
}
