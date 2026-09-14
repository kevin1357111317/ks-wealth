// KS Wealth 正式版號的唯一 runtime 來源。
// V3P26 是舊制最後一版；下一次產品出貨起使用 VMAJOR.MINOR.PATCH，細節見 VERSIONING.md。
const APP_VERSION = 'V3.27.2';

window.KS_APP_VERSION = APP_VERSION;
document.documentElement.dataset.appVersion = APP_VERSION;

function ensureVersionStyle() {
  if (document.querySelector('#ks-app-version-style')) return;
  const style = document.createElement('style');
  style.id = 'ks-app-version-style';
  style.textContent = `
    .brand > div:last-child { display:flex; align-items:baseline; gap:var(--space-card, 8px); min-width:0; }
    .appVersionBadge {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-height:22px;
      padding:2px 8px;
      border:1px solid rgba(93,117,112,.22);
      border-radius:var(--radius-control, 999px);
      background:rgba(255,255,255,.48);
      color:var(--color-text-secondary, #6f7d79);
      font-size:var(--type-meta, 12px);
      font-weight:800;
      letter-spacing:.02em;
      line-height:1;
      white-space:nowrap;
    }
  `;
  document.head.append(style);
}

function applyAppVersion() {
  ensureVersionStyle();

  // app-v3 的品牌區目前只有 h1，原本找 .brand small 永遠找不到，所以版號沒有出現在畫面。
  // 改成直接在頁面標題右側建立一個小版號膠囊。
  const titleNode = document.querySelector('.brand h1');
  const brandText = titleNode?.parentElement;
  if (brandText) {
    let badge = brandText.querySelector(':scope > .appVersionBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'appVersionBadge';
      brandText.append(badge);
    }
    if (badge.textContent !== APP_VERSION) badge.textContent = APP_VERSION;
  }

  const baseTitle = '布布一二的家';
  const title = `${baseTitle} · ${APP_VERSION}`;
  if (document.title !== title) document.title = title;
}

applyAppVersion();

const versionObserver = new MutationObserver(() => applyAppVersion());
versionObserver.observe(document.querySelector('#root') ?? document.body, { childList: true, subtree: true });
