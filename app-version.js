// KS Wealth 正式版號的唯一 runtime 來源。
// V3P26 是舊制最後一版；下一次產品出貨起使用 VMAJOR.MINOR.PATCH，細節見 VERSIONING.md。
const APP_VERSION = 'V3.29.2';

window.KS_APP_VERSION = APP_VERSION;
document.documentElement.dataset.appVersion = APP_VERSION;

function ensureVersionStyle() {
  if (document.querySelector('#ks-app-version-style')) return;
  const style = document.createElement('style');
  style.id = 'ks-app-version-style';
  style.textContent = `
    .brand > div:last-child { min-width:0; }
    .appVersionFooter {
      display:flex;
      align-items:center;
      justify-content:center;
      gap:6px;
      margin:10px 0 2px;
      color:var(--color-text-muted, #8c9895);
      font-size:var(--type-meta, 12px);
      letter-spacing:.04em;
      line-height:1;
    }
    .appVersionFooter:before,
    .appVersionFooter:after {
      flex:1;
      max-width:56px;
      height:1px;
      background:currentColor;
      opacity:.28;
      content:"";
    }
  `;
  document.head.append(style);
}

function applyAppVersion() {
  ensureVersionStyle();

  // 版號放在內容最後、兩條細線中間，是一般 App 擺版號的位置：不佔標題、
  // 不浮在內容上、也不會跟右下角的 FAB 擠在一起。兩條線是為了讓它看起來
  // 像頁尾，而不是最後一張卡片底下多出來的一行字。
  const content = document.querySelector('main.content');
  if (content) {
    let badge = content.querySelector(':scope > .appVersionFooter');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'appVersionFooter';
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
