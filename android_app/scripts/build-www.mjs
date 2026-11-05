// Copies the phone app (index.html at the repository root) into www/ for the Android build,
// adding the native bundle before the app's own scripts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const src = join(app, '..', 'index.html');
let html = readFileSync(src, 'utf8');

const marker = '<script id="analysis">';
if (!html.includes(marker)) throw new Error(`${src}: could not find ${marker}`);
html = html.replace(marker, '<script src="native.js"></script>\n' + marker);

mkdirSync(join(app, 'www'), { recursive: true });
writeFileSync(join(app, 'www', 'index.html'), html);
console.log(`www/index.html written from ${src} (${html.length} bytes)`);
