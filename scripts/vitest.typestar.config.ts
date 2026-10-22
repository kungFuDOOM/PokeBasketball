import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['scripts/draft-type-star.bench.ts'], reporters: ['verbose'], disableConsoleIntercept: true } });
