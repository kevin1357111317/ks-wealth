// KS Wealth 正式版號的唯一來源。
// 規則：大更新 V1 -> V2；小更新 V1 -> V1P1 -> V1P2。
const APP_VERSION = 'V1';

window.KS_APP_VERSION = APP_VERSION;
document.documentElement.dataset.appVersion = APP_VERSION;

function applyAppVersion() {
  const brandMeta = document.querySelector('.brand small');
  if (brandMeta) {
    const clean = brandMeta.textContent.replace(/\s*·\s*V\d+(?:P\d+)?\s*$/, '').trim();
    const next = clean ? `${clean} · ${APP_VERSION}` : APP_VERSION;
    if (brandMeta.textContent.trim() !== next) brandMeta.textContent = next;
  }

  const baseTitle = '布布一二的家';
  const title = `${baseTitle} · ${APP_VERSION}`;
  if (document.title !== title) document.title = title;
}

applyAppVersion();

const versionObserver = new MutationObserver(() => applyAppVersion());
versionObserver.observe(document.querySelector('#root') ?? document.body, { childList: true, subtree: true });
