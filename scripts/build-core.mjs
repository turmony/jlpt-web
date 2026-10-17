import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildCoreMarkdown(output) {
  await build({
    entryPoints: [resolve(root, 'mobile/core-markdown.jsx')],
    outfile: resolve(output, 'core-markdown.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
}
