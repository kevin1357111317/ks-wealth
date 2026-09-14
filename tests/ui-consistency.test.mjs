import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../ui-consistency.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');

test('共用排版層最後載入，並固定主要資訊層級', () => {
  const health = index.indexOf('/health.css');
  const consistency = index.indexOf('/ui-consistency.css?v=V3.27.2');
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


test('全站使用同一組語意顏色與元件尺度', () => {
  assert.match(css, /--color-finance-gain:#c43c55/);
  assert.match(css, /--color-finance-loss:#16836c/);
  assert.match(css, /--height-control:2\.75rem/);
  assert.match(css, /--color-owner-husband:#0057b8/);
  assert.match(css, /--color-owner-wife:#e24a1a/);
  assert.match(css, /\.up,[^{]+\{[^}]*color:var\(--color-finance-gain\)/);
  assert.match(css, /\.down,[^{]+\{[^}]*color:var\(--color-finance-loss\)/);
  assert.match(css, /\.portfolioStockMeta b,\.portfolioPair b,\.loanFacts b,[^{]+\{[^}]*font-size:\.9375rem/);
  assert.match(css, /\.portfolioMetric,\.portfolioStockCard,\.loanCard,\.healthScore,\.healthCoupleScore,[^{]+\{[^}]*border-radius:var\(--radius-card\)/);
  assert.match(css, /\.healthCouplePerson>span,\.healthCouplePerson>b,\.healthCompareFocus>span\{color:var\(--color-owner-husband\)/);
});

test('股票損益與年化各自依數值套用一致漲跌色', () => {
  assert.match(app, /const portfolioTone = value =>/);
  assert.doesNotMatch(app, /目前美股市值/);
  assert.match(app, /目前市值.*以目前匯率換算/);
  assert.doesNotMatch(app, /目前美股市值/);
  assert.match(app, /class="\$\{nativeProfitTone\}".*class="\$\{nativeXirrTone\}"/);
  assert.match(app, /class="\$\{profitTone\}".*class="\$\{xirrTone\}"/);
  assert.doesNotMatch(app, /class="\$\{stockTone\}"/);
});


test('版號不佔用頂部標題，排序工具列維持兩列網格', async () => {
  const version = await readFile(new URL('../app-version.js', import.meta.url), 'utf8');
  assert.match(version, /bottomNav.*appVersionBadge/);
  assert.doesNotMatch(version, /status.*appVersionBadge/);
  assert.match(css, /\.portfolioToolbar\{[^}]*display:grid/);
  assert.match(css, /grid-template-areas:"count sort" "exited exited"/);
  assert.match(css, /\.status>\[data-status-text\]\{[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.bottomNav \.appVersionBadge\{[^}]*position:absolute/);
});
