import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/adapters/outbound/database-schema.ts', './src/adapters/outbound/auth-schema.ts'],
  out: './drizzle',
  breakpoints: true,
  strict: true,
});
