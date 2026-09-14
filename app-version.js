// KS Wealth 正式版號的唯一 runtime 來源。
// V3P26 是舊制最後一版；下一次產品出貨起使用 VMAJOR.MINOR.PATCH，細節見 VERSIONING.md。
const APP_VERSION = 'V3.27.4';

window.KS_APP_VERSION = APP_VERSION;
document.documentElement.dataset.appVersion = APP_VERSION;

function ensureVersionStyle() {
  if (document.querySelector('#ks-app-version-style')) return;
  const style = document.createElement('style');
  style.id = 'ks-app-version-style';
  style.textContent = `
    .brand > div:last-child { min-width:0; }
    .status .appVersionBadge { margin-right:var(--space-inline, 8px); flex:0 0 auto; }
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

  // 版號放在行情狀態列，不佔用標題寬度，避免手機頂部標題被擠成多行。
  const status = document.querySelector('.status');
  const reload = status?.querySelector('#reload');
  if (status) {
    let badge = status.querySelector(':scope > .appVersionBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'appVersionBadge';
      if (reload) status.insertBefore(badge, reload);
      else status.append(badge);
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
