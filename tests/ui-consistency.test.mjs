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


test('版號收在內容最後當頁尾，不佔標題也不浮在內容上', async () => {
  const version = await readFile(new URL('../app-version.js', import.meta.url), 'utf8');
  assert.match(version, /main\.content/);
  assert.match(version, /appVersionFooter/);
  // 釘在 bottomNav 上會壓到內容與 FAB；掛進 .brand 會跟頁面標題搶位置。
  assert.doesNotMatch(version, /bottomNav/);
  assert.doesNotMatch(version, /\.brand \.appVersion/);
  assert.doesNotMatch(css, /\.appVersionFooter\{[^}]*position:absolute/);
  assert.match(css, /\.content>\.appVersionFooter\{/);
});

test('排序留三個依據加雙向方向鈕，已出清維持核取方塊', async () => {
  // 八個「依據 + 方向」的組合擠在一個 select 裡，光讀選項就吃掉半行寬度。
  assert.match(app, /data-portfolio-sort aria-label="排序依據"/);
  assert.match(app, /\['marketValue', '市值'\], \['xirr', '年化報酬率'\], \['profit', '損益'\]/);
  // 總報酬率跟年化在講同一件事，投入時間不同時只有年化可比，所以選單裡只留年化。
  assert.doesNotMatch(app, /\['return', /);
  assert.match(app, /data-sort-direction="\$\{sortDirection\}"/);
  // 方向只翻轉排序，排序依據不能被順手改掉。
  assert.match(app, /data-sort-direction\]'\)\.onclick = \(\) => \{ portfolioSort = `\$\{sortCriterion\}-\$\{ascending \? 'desc' : 'asc'\}`/);
  assert.match(app, /data-portfolio-sort\]'\)\.onchange = event => \{ portfolioSort = `\$\{event\.target\.value\}-\$\{sortDirection\}`/);
  // 雙向箭頭：兩支都畫出來，按鈕才看得出按下去會反向。
  assert.match(app, /class="sortAsc"/);
  assert.match(app, /class="sortDesc"/);
  assert.match(app, /type="checkbox" data-show-exited/);
  assert.doesNotMatch(app, /portfolioChip/);
  assert.match(css, /\.portfolioToolbar\{[^}]*display:flex/);
  assert.match(css, /\.portfolioSort\{\s*margin-left:auto/);
  assert.match(css, /\.portfolioSortDir\[data-sort-direction="asc"\] \.sortDesc\{opacity:\.3\}/);
  assert.match(css, /\.status>\[data-status-text\]\{[^}]*text-overflow:ellipsis/);
});

test('健康報告是第四個底部分頁，不再佔用家庭頁第一屏', async () => {
  const trends = await readFile(new URL('../v3-trends.css', import.meta.url), 'utf8');
  const health = await readFile(new URL('../health.css', import.meta.url), 'utf8');
  assert.match(app, /\['health', navHeart, '健康報告'\]/);
  // 走 tab 而不是 analysisScreen，底部導覽才會把它標成 on，也不會多推一筆歷史。
  assert.match(app, /if \(tab === 'health'\) return healthPage\(\);/);
  assert.doesNotMatch(app, /data-open-health/);
  assert.doesNotMatch(app, /healthHomeEntry/);
  assert.doesNotMatch(health, /healthHomeEntry/);
  assert.doesNotMatch(css, /healthHomeEntry/);
  // 四個分頁要平均分欄，不然第四顆會擠掉前三顆。
  assert.doesNotMatch(trends, /\.bottomNav\{grid-template-columns:repeat\(3,1fr\)/);
  assert.match(trends, /\.bottomNav\{grid-template-columns:repeat\(4,1fr\)/);
  assert.match(trends, /\.bottomNav \.navHeart\{/);
});
