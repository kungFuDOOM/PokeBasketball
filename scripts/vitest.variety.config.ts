import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['scripts/draft-variety.bench.ts'], reporters: ['verbose'], disableConsoleIntercept: true } });
