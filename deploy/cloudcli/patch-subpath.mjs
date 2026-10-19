// Rewrites the installed CloudCLI frontend to run under /code/ (see subpath-shim.js).
// Idempotent. Every bundle pattern must match exactly once or the script throws, so a changed
// bundle fails loudly; VERIFIED only lists the versions it was last checked against (others warn).
// Usage: node patch-subpath.mjs /srv/cloudcli/node_modules/@cloudcli-ai/cloudcli
import {readFile, writeFile, copyFile, readdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const VERIFIED = ['1.37.4', '1.37.5'];
const app = resolve(process.argv[2] || '/srv/cloudcli/node_modules/@cloudcli-ai/cloudcli');
const dist = resolve(app, 'dist');
const {version} = JSON.parse(await readFile(resolve(app, 'package.json'), 'utf8'));
if (!VERIFIED.includes(version)) console.warn(`CloudCLI ${version} is not in the verified list (${VERIFIED.join(', ')}); patterns must still match exactly`);

// Root-absolute same-origin paths, excluding protocol-relative and already prefixed ones.
const rooted = '/(?!/|code/)';
function replaceOnce(text, pattern, replacement, label) {
  if (text.includes(replacement)) return text;
  const count = text.split(pattern).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return text.replace(pattern, replacement);
}

// CloudCLI serves .js as immutable for a year, so the shim URL carries its content hash.
const shimSource = resolve(dirname(fileURLToPath(import.meta.url)), 'subpath-shim.js');
const shimHash = createHash('sha256').update(await readFile(shimSource)).digest('hex').slice(0, 12);
await copyFile(shimSource, resolve(dist, 'subpath-shim.js'));
const shimTag = `<script src="/code/subpath-shim.js?v=${shimHash}"></script>`;

let html = await readFile(resolve(dist, 'index.html'), 'utf8');
html = html.replace(new RegExp(`(href|src)="${rooted}`, 'g'), '$1="/code/');
html = html.replace(/\n    <script src="\/code\/subpath-shim\.js[^"]*"><\/script>/, '');
html = replaceOnce(html, '<head>', `<head>\n    ${shimTag}`, 'index.html head');
await writeFile(resolve(dist, 'index.html'), html);

const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
manifest.start_url = manifest.scope = '/code/';
for (const icon of manifest.icons || []) icon.src = icon.src.replace(new RegExp(`^${rooted}`), '/code/');
await writeFile(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const sw = await readFile(resolve(dist, 'sw.js'), 'utf8');
if (!sw.includes("'/code/manifest.json'") && !sw.includes("'/manifest.json'")) throw new Error('sw.js: manifest.json reference not found');
await writeFile(resolve(dist, 'sw.js'), sw.replace(/'\/manifest\.json'/g, "'/code/manifest.json'"));

const main = (await readdir(resolve(dist, 'assets'))).filter(name => /^index-.*\.js$/.test(name));
if (main.length !== 1) throw new Error(`expected one index bundle, found ${main.length}`);
const bundlePath = resolve(dist, 'assets', main[0]);
let bundle = await readFile(bundlePath, 'utf8');
// Vite's dynamic-import preload base and the logo image are the only root paths not covered by the shim.
bundle = replaceOnce(bundle, 'function(e){return"/"+e}', 'function(e){return"/code/"+e}', 'vite preload base');
if (!bundle.includes('src:"/logo.svg"') && !bundle.includes('src:"/code/logo.svg"')) throw new Error('logo.svg reference not found');
bundle = bundle.replaceAll('src:"/logo.svg"', 'src:"/code/logo.svg"');
// Always dark, matching the study pages, regardless of the OS or a stored choice.
bundle = replaceOnce(bundle, 'return e==="dark"||e==="light"?e:"system"}', 'return"dark"}', 'forced dark theme');
await writeFile(bundlePath, bundle);
// The bundle keeps its file name but is served immutable; a content hash in the URL makes browsers refetch it.
const bundleHash = createHash('sha256').update(bundle).digest('hex').slice(0, 12);
html = html.replace(new RegExp(`(/code/assets/${main[0].replace('.', '\\.')})(\\?v=\\w+)?"`), `$1?v=${bundleHash}"`);
await writeFile(resolve(dist, 'index.html'), html);
// The service runs as root with WORKSPACES_ROOT=/root/projects. Upstream forbids
// everything under /root, which would reject that root itself; containment in
// WORKSPACES_ROOT still keeps workspaces inside /root/projects.
const utilsPath = resolve(app, 'dist-server/server/shared/utils.js');
const utils = await readFile(utilsPath, 'utf8');
if (!utils.includes('export const FORBIDDEN_WORKSPACE_PATHS = [')) throw new Error('workspace guard: list not found');
const rootEntry = "    '/root',\n";
const rootCount = utils.split(rootEntry).length - 1;
if (rootCount > 1) throw new Error(`workspace guard: expected at most 1 /root entry, found ${rootCount}`);
if (rootCount === 1) await writeFile(utilsPath, utils.replace(rootEntry, ''));
// The model picker labels are bare aliases ("Sonnet"); show the concrete version each alias resolves to.
const modelsPath = resolve(app, 'dist-server/server/modules/providers/list/claude/claude-models.provider.js');
let models = await readFile(modelsPath, 'utf8');
const labels = [
  ["label: 'Fable 5',", "label: 'Fable 5.1',"],
  ["label: 'Sonnet',", "label: 'Sonnet 5.5',"],
  ["label: 'Sonnet (1M context)',", "label: 'Sonnet 5.5 (1M context)',"],
  ["label: 'Opus',", "label: 'Opus 5.5',"],
  ["label: 'Opus (1M context)',", "label: 'Opus 5.5 (1M context)',"],
  ["label: 'Haiku',", "label: 'Haiku 5.5',"],
  ["label: 'Opus Plan',", "label: 'Opus 5.5 Plan',"],
];
for (const [from, to] of labels) models = replaceOnce(models, from, to, `model label ${from}`);
await writeFile(modelsPath, models);
console.log(`Patched CloudCLI ${version} for /code/`);
