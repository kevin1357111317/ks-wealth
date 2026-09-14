// KS Wealth 正式版號的唯一 runtime 來源。
// V3P26 是舊制最後一版；下一次產品出貨起使用 VMAJOR.MINOR.PATCH，細節見 VERSIONING.md。
const APP_VERSION = 'V3.27.6';

window.KS_APP_VERSION = APP_VERSION;
document.documentElement.dataset.appVersion = APP_VERSION;

function ensureVersionStyle() {
  if (document.querySelector('#ks-app-version-style')) return;
  const style = document.createElement('style');
  style.id = 'ks-app-version-style';
  style.textContent = `
    .brand > div:last-child { min-width:0; }
    .content > .appVersionBadge {
      margin:2px 0 0;
      color:var(--color-text-muted, #8c9895);
      font-size:var(--type-meta, 12px);
      font-weight:600;
      letter-spacing:.06em;
      line-height:1;
      text-align:center;
      white-space:nowrap;
    }
  `;
  document.head.append(style);
}

function applyAppVersion() {
  ensureVersionStyle();

  // 版號是 footer 資訊：接在內容最後一張卡片之後，跟著頁面捲動。
  // 之前用 absolute 釘在底部導覽列上方，會浮在內容上、跟 FAB 擠在一起。
  const content = document.querySelector('main.content');
  if (content) {
    let badge = content.querySelector(':scope > .appVersionBadge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'appVersionBadge';
      content.append(badge);
    } else if (badge !== content.lastElementChild) {
      content.append(badge);
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
