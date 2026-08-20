// Must precede every other import so the environment is populated before any
// module that reads it is evaluated.
import 'dotenv/config';

import express, { Request, Response } from 'express';
import path from 'path';
import { extractArabicText, getUsagePayload } from './lib/ocr.js';

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

  app.use('/samples', express.static(path.join(process.cwd(), 'public', 'samples'), { maxAge: '1h' }));
  app.use('/samples', express.static(path.join(process.cwd(), 'samples'), { maxAge: '1h' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'Noon Arabic OCR', timestamp: new Date().toISOString() });
  });

  app.get('/api/v1/usage', (_req, res) => {
    res.json(getUsagePayload());
  });

  app.post('/api/v1/ocr/extract', async (req: Request, res: Response) => {
    const result = await extractArabicText(req.body || {});
    res.status(result.status).json(result.json);
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
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
