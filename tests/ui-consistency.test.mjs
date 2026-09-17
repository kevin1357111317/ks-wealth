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
  assert.match(app, /\['marketValue', '市值'\], \['xirr', 'XIRR 年化'\], \['profit', '損益'\]/);
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
  assert.match(app, /\['dashboard', navHome, '家庭'\]/);
  assert.match(app, /\['health', navHeart, '健康報告'\]/);
  // 順序：家庭、老公、老婆、健康。
  assert.match(app, /\['dashboard', navHome, '家庭'\],\n\s*\['husband',[^\n]*\n\s*\['wife',[^\n]*\n\s*\['health', navHeart/);
  // 走 tab 而不是 analysisScreen，底部導覽才會把它標成 on，也不會多推一筆歷史。
  assert.match(app, /if \(tab === 'health'\) return healthPage\(\);/);
  assert.doesNotMatch(app, /data-open-health/);
  assert.doesNotMatch(app, /healthHomeEntry/);
  assert.doesNotMatch(health, /healthHomeEntry/);
  assert.doesNotMatch(css, /healthHomeEntry/);
  // 四個分頁要平均分欄，不然第四顆會擠掉前三顆。
  assert.doesNotMatch(trends, /\.bottomNav\{grid-template-columns:repeat\(3,1fr\)/);
  assert.match(trends, /\.bottomNav\{grid-template-columns:repeat\(4,1fr\)/);
  assert.match(trends, /\.bottomNav \.navCharacter\{/);
  assert.match(trends, /\.bottomNav \.navBear\{display:block;width:40px;height:40px/);
  assert.match(trends, /\.bottomNav \.navCharacter\{display:block;width:40px;height:40px/);
  assert.match(trends, /\.bottomNav \.navCharacter\.navFamily\{width:42px;height:34px/);
  assert.match(app, /class="navCharacter navHome navFamily"/);
  assert.match(app, /const familyBearsIcon = 'data:image\/png;base64,/);
  assert.match(app, /class="navCharacter navHeart"/);
  assert.doesNotMatch(app, /class="navFace"|class="navBlush"/);
  const navIcons = app.slice(app.indexOf('const navHeart'), app.indexOf('const tabs'));
  assert.doesNotMatch(navIcons, /stroke-width="(?:2|3)(?:\.|\")/);
  assert.match(navIcons, /stroke-width="1\.9"/);
});

test('股票分析先切畫面，台帳在背景預載且不重複重繪', () => {
  assert.match(app, /scheduleLedgerWarmup\(\);/);
  assert.match(app, /requestIdleCallback' in window/);
  const start = app.indexOf('function openAnalysis(screen, ownerScope)');
  const end = app.indexOf('\n}\n\n// 手勢', start) + 2;
  const handler = app.slice(start, end);
  assert.match(handler, /const needsStockLedger = screen === 'stocks' && !ledgerLoaded;/);
  assert.match(handler, /render\(\);\n\s*window\.scrollTo\(0, 0\);\n\s*if \(needsStockLedger\)/);
  assert.doesNotMatch(handler, /if \(screen === 'stocks'\) void ensureLedger/);
});

test('切換不同底部分頁會回到新頁面頂端', () => {
  const start = app.indexOf("root.querySelector('.bottomNav').onclick");
  const end = app.indexOf('\n  };\n}', start);
  const handler = app.slice(start, end);
  assert.match(handler, /const nextTab = button\.dataset\.tab;/);
  assert.match(handler, /if \(nextTab === tab && !analysisScreen\) return;/);
  assert.match(handler, /tab = nextTab;/);
  assert.match(handler, /render\(\);\n\s*window\.scrollTo\(0, 0\);/);
});

test('登入後先看自己的資產，不是家庭總覽', async () => {
  // household_members 沒有 user 對 owner_scope 的欄位，只能用 role 推：
  // 建立家庭的是老公，用邀請碼加入的是老婆。
  assert.match(app, /const memberOwnerScope = \(\) => member\?\.role === 'member' \? 'wife' : 'husband';/);
  // 要放在 resolveMembership 解出 member 之後，重新登入換人才會跟著換。
  assert.match(app, /if \(!member\) return joinScreen\(\);[\s\S]{0,240}?tab = memberOwnerScope\(\);/);
});

test('投資期間不滿一年用天顯示，不會擠成 0.00 年', () => {
  // 只持有幾天的部位（金益鼎 5 天、MRVL 當沖）用年當單位會全部變成 0.00／0.01 年。
  assert.match(app, /const holdingPeriodText = years =>/);
  assert.match(app, /days < 365 \? `\$\{formatNumber\(days\)\} 天` : `\$\{years\.toFixed\(2\)\} 年`/);
  assert.doesNotMatch(app, /stock\.holdingYears\.toFixed\(2\)/);
  assert.equal(app.split('holdingPeriodText(stock.holdingYears)').length - 1, 2, '台股與美股兩邊都要換');
});

test('股票模型有快取，報價重繪不會重算年化', () => {
  // calculatePortfolio 要跑每檔加三個彙總的 XIRR，1496 筆交易實測 ~300ms。
  // 台股報價每 5 秒 render() 一次，在股票分析頁就是每 5 秒卡 0.3 秒。
  assert.match(app, /let portfolioRevision = 0;/);
  assert.match(app, /let portfolioModelCache = \{ revision: -1, fxRate: null, byOwner: new Map\(\) \};/);
  // 快取鍵必須同時看版本號與匯率 —— 只看其中一個，換匯率或換台帳就會拿到舊數字。
  assert.match(app, /portfolioModelCache\.revision !== portfolioRevision \|\| portfolioModelCache\.fxRate !== fxRate/);
  // 畫面只准透過 portfolioModelFor\(\) 拿模型，不准自己再算一次。
  assert.equal(app.split('calculatePortfolio(').length - 1, 1,
    'calculatePortfolio() 只准在 portfolioModelFor() 裡呼叫一次，其他地方一律吃快取');
  assert.match(app, /const model = portfolioModelFor\(analysisOwner\);/);
  // 台帳、報價、換帳號三個地方都要讓快取失效，漏掉任何一個就會顯示舊數字。
  assert.equal(app.split('portfolioRevision += 1;').length - 1, 3,
    '報價更新、台帳載入、換帳號三處都要 bump 版本號');
});
