import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
// react (incl. react/jsx-runtime) and @pryntid/js stay external: they are peer dependencies.
const common = { entryPoints: ['src/index.tsx'], bundle: true, external: ['react', 'react/*', '@pryntid/js'],
                 jsx: 'automatic', target: ['es2020'], logLevel: 'info' };
await build({ ...common, format: 'esm', outfile: 'dist/index.mjs' });
await build({ ...common, format: 'cjs', outfile: 'dist/index.cjs' });

// Types: a type error fails the build (never publish without .d.ts). Same declarations for ESM
// (.d.ts) and CJS (.d.cts) consumers; '@pryntid/js' resolves to the matching flavor of its types.
rmSync('.types', { recursive: true, force: true });
execSync('npx tsc -p tsconfig.json --outDir .types', { stdio: 'inherit' });
const dts = readFileSync('.types/index.d.ts', 'utf8');
if (/from '\.\.?\//.test(dts)) { console.error('[build] index.d.ts must be self-contained'); process.exit(1); }
copyFileSync('.types/index.d.ts', 'dist/index.d.ts');
copyFileSync('.types/index.d.ts', 'dist/index.d.cts');
rmSync('.types', { recursive: true, force: true });
console.log('[build] done');
