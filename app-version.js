// KS Wealth 正式版號的唯一 runtime 來源。
// V3P26 是舊制最後一版；下一次產品出貨起使用 VMAJOR.MINOR.PATCH，細節見 VERSIONING.md。
const APP_VERSION = 'V3.27.7';

window.KS_APP_VERSION = APP_VERSION;
document.documentElement.dataset.appVersion = APP_VERSION;

function ensureVersionStyle() {
  if (document.querySelector('#ks-app-version-style')) return;
  const style = document.createElement('style');
  style.id = 'ks-app-version-style';
  style.textContent = `
    .brand > div:last-child { min-width:0; }
    .brand .appVersionBadge {
      display:block;
      margin-top:3px;
      color:var(--color-text-muted, #8c9895);
      font-size:var(--type-meta, 12px);
      font-weight:700;
      letter-spacing:.08em;
      line-height:1;
      white-space:nowrap;
    }
  `;
  document.head.append(style);
}

function applyAppVersion() {
  ensureVersionStyle();

  // 版號掛在頁首標題底下：那裡本來就有 .brand small 這個副標欄位，
  // 版號放進去會跟著標題一起捲走，不會像之前那樣浮在內容或底部導覽列上。
  const brandText = document.querySelector('.brand > div:last-child');
  if (brandText) {
    let badge = brandText.querySelector(':scope > .appVersionBadge');
    if (!badge) {
      badge = document.createElement('small');
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
