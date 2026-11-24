import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

/** Chrome's match patterns: scheme://host/path, where * in the host or path is a wildcard and the path is checked against path + query. */
function matches(pattern, url) {
  const [, scheme, host, path] = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  const u = new URL(url);
  const re = (glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const hostOk = host === '*' || (host.startsWith('*.') ? u.hostname === host.slice(2) || u.hostname.endsWith(host.slice(1)) : u.hostname === host);
  const schemeOk = scheme === '*' ? ['http:', 'https:'].includes(u.protocol) : u.protocol === `${scheme}:`;
  return schemeOk && hostOk && re(path).test(u.pathname + u.search);
}
const injectedOn = (url) => manifest.content_scripts[0].matches.some((p) => matches(p, url));
const exposedTo = (url) => manifest.web_accessible_resources[0].matches.some((p) => matches(p, url));

test('manifest: the content script runs on Google Search and Maps only, over https, and nowhere else on Google', () => {
  for (const url of [
    'https://www.google.com/search?q=krasi+boston',
    'https://www.google.com/search?q=krasi&hl=en',
    'https://www.google.com/maps/place/Krasi/@42.34,-71.08,17z',
    'https://www.google.com/maps?q=krasi',
    'https://www.google.com/maps',
    'https://www.google.co.uk/search?q=pub',
    'https://www.google.ca/maps/search/coffee',
    'https://www.google.com.au/search?q=cafe',
    'https://www.google.co.nz/maps',
    'https://www.google.ie/search?q=pub',
  ]) assert.equal(injectedOn(url), true, `should run on ${url}`);

  for (const url of [
    'https://mail.google.com/mail/u/0/',
    'https://docs.google.com/document/d/abc/edit',
    'https://drive.google.com/drive/my-drive',
    'https://accounts.google.com/signin',
    'https://www.google.com/',
    'https://www.google.com/imghp',
    'https://www.google.com/travel/flights',
    'http://www.google.com/search?q=x',
    'https://www.google.de/search?q=x',
    'https://example.com/search?q=x',
  ]) assert.equal(injectedOn(url), false, `must not run on ${url}`);
});

test('manifest: no pattern is a wildcard host or scheme, and no host permission is requested', () => {
  const all = [...manifest.content_scripts[0].matches, ...manifest.web_accessible_resources[0].matches];
  for (const pattern of all) {
    assert.match(pattern, /^https:\/\/www\.google\.[a-z.]+\//, pattern);
    assert.ok(!pattern.includes('*://') && !pattern.includes('//*'), `wildcard host or scheme in ${pattern}`);
  }
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.permissions, ['storage']);
});

test('manifest: the extension\'s modules are exposed to the same sites the script runs on, and no others', () => {
  assert.equal(exposedTo('https://www.google.com/search?q=x'), true);
  assert.equal(exposedTo('https://www.google.co.uk/maps'), true);
  assert.equal(exposedTo('https://mail.google.com/'), false);
  assert.equal(exposedTo('http://www.google.com/search'), false);
  // every site the script runs on can load its modules (else the dynamic import fails there)
  const origins = new Set(manifest.content_scripts[0].matches.map((p) => new URL(p.replace('*', '')).origin));
  for (const origin of origins) assert.equal(exposedTo(`${origin}/search?q=x`), true, origin);
});
