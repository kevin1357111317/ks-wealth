import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../ui-consistency.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');

test('共用排版層最後載入，並固定主要資訊層級', () => {
  const health = index.indexOf('/health.css');
  // 只看載入順序，不鎖快取字串 —— 每次出貨都會換 ?v=，鎖死等於每次都假紅。
  const consistency = index.indexOf('/ui-consistency.css?v=');
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


test('版號掛在頁首標題底下，不浮在內容或底部導覽列上', async () => {
  const version = await readFile(new URL('../app-version.js', import.meta.url), 'utf8');
  assert.match(version, /\.brand > div:last-child/);
  assert.doesNotMatch(version, /bottomNav.*appVersionBadge/);
  assert.doesNotMatch(version, /main\.content/);
  // 絕對定位會讓版號壓在內容與 FAB 上，那是 V3.27.6 之前的問題。
  assert.doesNotMatch(css, /\.bottomNav \.appVersionBadge\{[^}]*position:absolute/);
  assert.match(css, /\.brand \.appVersionBadge\{/);
});

test('排序拆成依據與方向，已出清是可切換的 chip', async () => {
  // 八個「市值｜高到低」選項擠在一個 select 裡，光讀選項就吃掉半行寬度。
  assert.match(app, /data-portfolio-sort aria-label="排序依據"/);
  assert.match(app, /\['marketValue', '市值'\], \['xirr', '年化'\], \['return', '報酬率'\], \['profit', '損益'\]/);
  assert.doesNotMatch(app, /市值｜高到低/);
  assert.match(app, /data-sort-direction="\$\{sortDirection\}"/);
  // 方向只翻轉箭頭，排序依據不能被順手改掉。
  assert.match(app, /data-sort-direction\]'\)\.onclick = \(\) => \{ portfolioSort = `\$\{sortCriterion\}-\$\{ascending \? 'desc' : 'asc'\}`/);
  assert.match(app, /data-portfolio-sort\]'\)\.onchange = event => \{ portfolioSort = `\$\{event\.target\.value\}-\$\{sortDirection\}`/);
  assert.match(app, /class="portfolioChip" data-show-exited aria-pressed=/);
  assert.doesNotMatch(app, /type="checkbox" data-show-exited/);
  assert.match(css, /\.portfolioToolbar\{[^}]*display:flex/);
  assert.match(css, /\.portfolioTools\{[^}]*margin-left:auto/);
  assert.match(css, /\.portfolioSortDir\[data-sort-direction="asc"\] svg\{transform:rotate\(180deg\)/);
  assert.match(css, /\.portfolioChip\[aria-pressed="true"\]\{/);
  assert.match(css, /\.status>\[data-status-text\]\{[^}]*text-overflow:ellipsis/);
});
