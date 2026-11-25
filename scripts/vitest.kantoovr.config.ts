import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['scripts/kanto-ovr.bench.ts'] } });
