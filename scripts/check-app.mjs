import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const config = readFileSync(join(root, 'vite.config.js'), 'utf8');
const pages = [...config.matchAll(/process\.cwd\(\), '([^']+\.html)'/g)].map(match => match[1]);
const routes = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')).rewrites;
const errors = [];
const temporary = mkdtempSync(join(tmpdir(), 'courtly-check-'));
let scriptsChecked = 0;
const content = new Map(pages.map(path => [path, readFileSync(join(root, path), 'utf8')]));

function syntax(source, label) {
  const file = join(temporary, `${scriptsChecked++}.mjs`);
  writeFileSync(file, source);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) errors.push(`${label}: ${result.stderr.replaceAll(file, label).trim()}`);
}

try {
  for (const [page, html] of content) {
    if (!/<meta\b[^>]*name=["']viewport["']/i.test(html)) errors.push(`${page}: missing viewport metadata`);
    if (!/<title>[\s\S]+?<\/title>/i.test(html)) errors.push(`${page}: missing page title`);
    for (const [index, match] of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
      if (!/\bsrc\s*=/.test(match[1]) && !/type=["'](?:application\/ld\+json|importmap)["']/.test(match[1]) && match[2].trim()) syntax(match[2], `${page} inline script ${index + 1}`);
    }
    const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    const ids = [...markup.matchAll(/\bid=["']([^"']+)["']/gi)].map(match => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length) errors.push(`${page}: duplicate IDs ${[...new Set(duplicates)].join(', ')}`);
    for (const match of markup.matchAll(/<(?:a|link|img|script)\b[^>]*\b(?:href|src)=["']([^"']+)["']/gi)) {
      const href = match[1];
      if (!href || /^(?:[a-z]+:|\/\/)/i.test(href) || href.includes('${')) continue;
      const url = new URL(href, `https://courtly.test/${page}`);
      const path = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      const route = routes.find(row => new RegExp(`^${row.source.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname));
      if (!existsSync(join(root, path)) && !existsSync(join(root, 'public', path)) && !route && !path.startsWith('api/')) errors.push(`${page}: missing local target ${href}`);
      if (url.hash.length > 1 && url.pathname === `/${page}` && !ids.includes(decodeURIComponent(url.hash.slice(1)))) errors.push(`${page}: missing section ${url.hash}`);
    }
  }
  const roots = ['', 'public', 'api', 'api/receipts', 'api/cron'];
  for (const dir of roots) {
    const absolute = join(root, dir);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js') && !/ \(\d+\)/.test(entry.name)) syntax(readFileSync(join(absolute, entry.name), 'utf8'), join(dir, entry.name));
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked all ${pages.length} built pages and ${scriptsChecked} scripts: titles, viewport metadata, unique IDs, internal links and JavaScript syntax passed.`);
}
