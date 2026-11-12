import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// The version the agent reports to the server (sdkVersion) must match the published version.
const src = readFileSync('src/index.ts', 'utf8');
const m = src.match(/const SDK_VERSION = '([^']+)'/);
if (!m || m[1] !== pkg.version) {
  console.error(`[build] SDK_VERSION in src/index.ts (${m && m[1]}) != package.json version (${pkg.version})`);
  process.exit(1);
}

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
// Source maps are 'external' (written for /cdn debugging, not linked from the bundles) because
// npm ships only the bundles — a dangling sourceMappingURL would 404 on unpkg/jsDelivr.
const common = { entryPoints: ['src/index.ts'], bundle: true, sourcemap: 'external', target: ['es2019'], logLevel: 'info' };
// Install channel the agent reports (SDK_INFO.channel): the script-tag builds say 'cdn'; the module
// builds say 'npm', or what PRYNT_CHANNEL says (scripts/sdk/sdk.py sets 'download' for /downloads).
const moduleChannel = process.env.PRYNT_CHANNEL || 'npm';
if (!['npm', 'download', 'cdn'].includes(moduleChannel)) { console.error(`[build] bad PRYNT_CHANNEL ${moduleChannel}`); process.exit(1); }
const channel = (c) => ({ define: { __PRYNT_CHANNEL__: JSON.stringify(c), __PRYNT_VERSION__: JSON.stringify(pkg.version) } });

await build({ ...common, ...channel(moduleChannel), format: 'esm', outfile: 'dist/prynt.mjs', minify: true });
await build({ ...common, ...channel(moduleChannel), format: 'cjs', outfile: 'dist/prynt.cjs', minify: true });
// UMD-ish build for <script> / CDN: exposes global `Prynt`
await build({
  ...common, ...channel('cdn'), format: 'iife', globalName: 'Prynt', outfile: 'dist/prynt.umd.js', minify: true,
  footer: { js: 'Prynt=Prynt.default||Prynt;' },
});
// Reveal-only builds (src/reveal_entry.ts): no device-intelligence code. UMD global `PryntReveal`
// at /cdn/prynt-reveal.umd.js (the console snippet for Reveal-only customers), ESM/CJS as `@pryntid/js/reveal`.
const revealOnly = { ...common, entryPoints: ['src/reveal_entry.ts'], minify: true };
await build({ ...revealOnly, ...channel(moduleChannel), format: 'esm', outfile: 'dist/prynt-reveal.mjs' });
await build({ ...revealOnly, ...channel(moduleChannel), format: 'cjs', outfile: 'dist/prynt-reveal.cjs' });
await build({ ...revealOnly, ...channel('cdn'), format: 'iife', globalName: 'PryntReveal', outfile: 'dist/prynt-reveal.umd.js',
  footer: { js: 'PryntReveal=PryntReveal.default||PryntReveal;' } });
// Replay recorder (src/replay_entry.ts: rrweb + fflate): UMD global `PryntReplay` at /cdn/prynt-replay.umd.js,
// injected on demand by Prynt.replay() of the core bundle; ESM/CJS as `@pryntid/js/replay`.
const replayOnly = { ...common, entryPoints: ['src/replay_entry.ts'], minify: true };
await build({ ...replayOnly, ...channel(moduleChannel), format: 'esm', outfile: 'dist/prynt-replay.mjs' });
await build({ ...replayOnly, ...channel(moduleChannel), format: 'cjs', outfile: 'dist/prynt-replay.cjs' });
await build({ ...replayOnly, ...channel('cdn'), format: 'iife', globalName: 'PryntReplay', outfile: 'dist/prynt-replay.umd.js',
  footer: { js: 'PryntReplay=PryntReplay.default||PryntReplay;' } });
// Feedback widget (src/feedback_entry.ts): UMD global `PryntFeedback` at /cdn/prynt-feedback.umd.js, injected by the
// recorder only on sites that turned the widget on (Replay → Privacy & settings → Feedback).
await build({ ...common, entryPoints: ['src/feedback_entry.ts'], minify: true, ...channel('cdn'), format: 'iife',
  globalName: 'PryntFeedback', outfile: 'dist/prynt-feedback.umd.js' });
// Non-minified UMD for the playground/debugging (served from /cdn, not published to npm).
await build({ ...common, ...channel('cdn'), format: 'iife', globalName: 'Prynt', outfile: 'dist/prynt.global.js', minify: false,
  footer: { js: 'Prynt=Prynt.default||Prynt;' } });

if (!watch) {
  // Type declarations. index.d.ts is self-contained (no relative imports), so the same file
  // serves ESM consumers (.d.ts, package "type": "module") and CJS consumers (.d.cts).
  // A type error fails the build: never publish without types.
  rmSync('.types', { recursive: true, force: true });
  execSync('npx tsc -p tsconfig.json --outDir .types', { stdio: 'inherit' });
  const dts = readFileSync('.types/index.d.ts', 'utf8');
  if (/from '\.\.?\//.test(dts)) {
    console.error('[build] dist/index.d.ts must not import relative modules (keep public types in src/index.ts)');
    process.exit(1);
  }
  copyFileSync('.types/index.d.ts', 'dist/index.d.ts');
  copyFileSync('.types/index.d.ts', 'dist/index.d.cts');
  // Types of the Reveal-only entry (`@pryntid/js/reveal`): may import ./index only (shipped next to it).
  const rdts = readFileSync('.types/reveal_entry.d.ts', 'utf8');
  if (/from '\.\.?\/(?!index')/.test(rdts)) {
    console.error('[build] dist/reveal.d.ts may only import ./index');
    process.exit(1);
  }
  copyFileSync('.types/reveal_entry.d.ts', 'dist/reveal.d.ts');
  copyFileSync('.types/reveal_entry.d.ts', 'dist/reveal.d.cts');
  const pdts = readFileSync('.types/replay_entry.d.ts', 'utf8');
  if (/from '\.\.?\/(?!index')/.test(pdts)) {
    console.error('[build] dist/replay.d.ts may only import ./index');
    process.exit(1);
  }
  copyFileSync('.types/replay_entry.d.ts', 'dist/replay.d.ts');
  copyFileSync('.types/replay_entry.d.ts', 'dist/replay.d.cts');
  rmSync('.types', { recursive: true, force: true });
} else {
  const ctx = await (await import('esbuild')).context({ ...common, ...channel('cdn'), format: 'iife', globalName: 'Prynt',
    outfile: 'dist/prynt.global.js', minify: false, footer: { js: 'Prynt=Prynt.default||Prynt;' } });
  await ctx.watch();
}
console.log('[build] done');
