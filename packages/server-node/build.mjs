import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
const common = { entryPoints: ['src/index.ts'], bundle: true, platform: 'node', target: ['node18'], logLevel: 'info' };
await build({ ...common, format: 'esm', outfile: 'dist/index.mjs' });
await build({ ...common, format: 'cjs', outfile: 'dist/index.cjs' });

// Types: a type error fails the build (never publish without .d.ts). Same declarations for ESM
// (.d.ts) and CJS (.d.cts) consumers.
rmSync('.types', { recursive: true, force: true });
execSync('npx tsc -p tsconfig.json --outDir .types', { stdio: 'inherit' });
const dts = readFileSync('.types/index.d.ts', 'utf8');
if (/from '\.\.?\//.test(dts)) { console.error('[build] index.d.ts must be self-contained'); process.exit(1); }
copyFileSync('.types/index.d.ts', 'dist/index.d.ts');
copyFileSync('.types/index.d.ts', 'dist/index.d.cts');
rmSync('.types', { recursive: true, force: true });
console.log('[build] done');
