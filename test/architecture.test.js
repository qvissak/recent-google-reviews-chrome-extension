import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function listJs(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listJs(p) : p.endsWith('.js') ? [p] : [];
  });
}

const layerOf = (file) => relative(root, file).split(sep)[0];
const RANK = { domain: 0, usecases: 1, adapters: 2, frameworks: 3 };

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Also blank string contents so only real code identifiers are checked. */
function stripCommentsAndStrings(source) {
  return stripComments(source)
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => m[0] + m[0]);
}

test('domain and usecases never reference DOM or Chrome APIs', () => {
  const forbidden = /\b(document|window|chrome|localStorage|sessionStorage|navigator|MutationObserver|HTMLElement|querySelector\w*|location)\b/;
  for (const file of listJs(root)) {
    if (!['domain', 'usecases'].includes(layerOf(file))) continue;
    const match = forbidden.exec(stripCommentsAndStrings(readFileSync(file, 'utf8')));
    assert.equal(match, null, `${relative(root, file)} references "${match?.[0]}"`);
  }
});

test('imports only point inward (never to an outer layer)', () => {
  const importRe = /(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g;
  for (const file of listJs(root)) {
    const own = layerOf(file);
    for (const [, spec] of stripComments(readFileSync(file, 'utf8')).matchAll(importRe)) {
      const target = layerOf(resolve(dirname(file), spec));
      assert.ok(
        RANK[target] <= RANK[own],
        `${relative(root, file)} (${own}) imports ${spec} (${target}) — dependency points outward`,
      );
    }
  }
});

test('manifest: every module the content script imports is web-accessible (else the real extension breaks)', () => {
  const projectRoot = resolve(root, '..');
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'manifest.json'), 'utf8'));
  const globs = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  const matches = (path) =>
    globs.some((glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(path));

  const importRe = /(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g;
  const entry = join(root, 'frameworks/content/ContentScriptController.js');
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of stripComments(readFileSync(file, 'utf8')).matchAll(importRe)) {
      queue.push(resolve(dirname(file), spec));
    }
  }
  assert.ok(seen.size > 15, `expected to crawl the whole graph, saw ${seen.size} files`);
  for (const file of seen) {
    const rel = relative(projectRoot, file).split(sep).join('/');
    assert.ok(matches(rel), `${rel} is imported by the content script but not listed in web_accessible_resources`);
  }

  // and the classic loader the manifest points at is the one that imports the entry
  assert.ok(readFileSync(join(projectRoot, manifest.content_scripts[0].js[0]), 'utf8').includes('ContentScriptController.js'));
  for (const css of manifest.content_scripts[0].css) assert.ok(readFileSync(join(projectRoot, css), 'utf8').includes('.rgr-modal'));
});
