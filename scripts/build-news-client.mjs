import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

// Bundles news-client/ into one IIFE for GET /api/news/client.js. The loader runs it with the free
// variable JLPT_NEWS; ui.css is imported as text and put into the shadow root.
export async function buildNewsClient(outfile) {
  await build({
    entryPoints: [resolve(root, 'news-client/main.mjs')],
    absWorkingDir: root,
    bundle: true,
    format: 'iife',
    target: ['safari15'],
    loader: {'.css': 'text'},
    outfile,
  });
}
