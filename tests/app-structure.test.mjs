import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('initial data renders before realtime and background quotes', () => {
  const resolver = source.slice(source.indexOf('async function resolveMembership'), source.indexOf('async function applySession'));
  assert.ok(resolver.indexOf('await loadData') < resolver.indexOf('subscribeRealtime()'));
  assert.ok(resolver.indexOf('subscribeRealtime()') < resolver.indexOf('void refreshQuotes'));
});

test('quote refresh and data loads use single-flight guards', () => {
  assert.match(source, /if \(loadFlight\) return loadFlight/);
  assert.match(source, /if \(quoteFlight\) return quoteFlight/);
});

test('realtime reloads are household-filtered and debounced', () => {
  assert.match(source, /filter: `household_id=eq\.\$\{householdId\}`/);
  assert.match(source, /}, 300\);/);
});

test('production shell loads the current app and PWA metadata', () => {
  assert.match(html, /app-v3\.js\?v=gold-1/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /apple-mobile-web-app-title" content="布布一二的家"/);
  assert.doesNotMatch(html, /src="\/app\.js/);
});
