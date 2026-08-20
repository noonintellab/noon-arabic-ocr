import dotenv from 'dotenv';

// .env.local holds the values Vercel pulls down for linked stores, .env holds
// the hand-written ones. Earlier files win, and neither overrides a real
// environment variable, so deployments are unaffected.
dotenv.config({ path: ['.env.local', '.env'] });
