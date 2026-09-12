import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../ui-consistency.css', import.meta.url), 'utf8');

test('共用排版層最後載入，並固定主要資訊層級', () => {
  const health = index.indexOf('/health.css');
  const consistency = index.indexOf('/ui-consistency.css?v=V3P20');
  assert.ok(health >= 0 && consistency > health, '共用排版層必須最後載入');
  assert.match(css, /--type-page-title:1\.5rem/);
  assert.match(css, /--type-section-title:1\.25rem/);
  assert.match(css, /--type-card-title:1rem/);
  assert.match(css, /\.sectionHead>:first-child\{[^}]*font-size:var\(--type-card-title\)/);
  assert.match(css, /\.portfolioMetric span\{font-size:\.8125rem/);
  assert.match(css, /\.portfolioMetric b\{[^}]*font-size:clamp\([^}]*white-space:nowrap/);
  assert.match(css, /\.miniStats b\{[^}]*font-size:clamp\([^}]*white-space:nowrap/);
  assert.match(css, /\.categoryTotal b\{[^}]*font-size:clamp\([^}]*white-space:nowrap/);
  assert.match(css, /\.compactAmount b,\.itemAmount b\{[^}]*font-size:clamp\([^}]*white-space:nowrap/);
  assert.match(css, /\.healthTrendPerson span,\.healthTrendPerson small\{font-size:var\(--type-meta\)/);
});
