import type { IncomingMessage, ServerResponse } from 'http';
import { createApp } from '../server';

type ExpressApp = (req: IncomingMessage, res: ServerResponse) => void;

let appPromise: Promise<ExpressApp> | null = null;

function getApp() {
  if (!appPromise) {
    appPromise = createApp() as Promise<ExpressApp>;
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  return app(req, res);
}

export const config = {
  maxDuration: 60
};
