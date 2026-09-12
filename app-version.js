// KS Wealth 正式版號的唯一來源。
// 規則：大更新 V1 -> V2；小更新 V1 -> V1P1 -> V1P2。
const APP_VERSION = 'V3P20';

window.KS_APP_VERSION = APP_VERSION;
document.documentElement.dataset.appVersion = APP_VERSION;

function ensureVersionStyle() {
  if (document.querySelector('#ks-app-version-style')) return;
  const style = document.createElement('style');
  style.id = 'ks-app-version-style';
  style.textContent = `
    .brand > div:last-child { display:flex; align-items:baseline; gap:8px; min-width:0; }
    .appVersionBadge {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-height:22px;
      padding:2px 8px;
      border:1px solid rgba(93,117,112,.22);
      border-radius:999px;
      background:rgba(255,255,255,.48);
      color:#6f7d79;
      font-size:10px;
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
