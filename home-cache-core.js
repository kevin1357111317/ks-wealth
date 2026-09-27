// 首頁快取：開 App 先畫上次的首頁，背景再換成最新資料。存的是 performDataLoad() 拿到的
// 原始列（不含健康資料），還原時走同一個套用函式，所以快取跟線上資料的算法不會分岔。
//
// 只存在這台裝置的 localStorage，依 user id 分開；換帳號或登出會清掉別人的。格式一改就把
// HOME_CACHE_VERSION 加一，舊快取會被當成沒有，而不是用新程式去讀舊結構。
export const HOME_CACHE_PREFIX = 'ks-home-cache|';
export const HOME_CACHE_VERSION = 1;

export function homeCacheKey(userId) {
  return userId ? `${HOME_CACHE_PREFIX}${userId}` : '';
}

export function encodeHomeCache({ userId, member, rows, savedAt = new Date().toISOString() }) {
  return JSON.stringify({ v: HOME_CACHE_VERSION, userId, member, rows, savedAt });
}

export function decodeHomeCache(raw, userId) {
  if (!raw || !userId) return null;
  try {
    const data = JSON.parse(raw);
    if (data?.v !== HOME_CACHE_VERSION || data.userId !== userId) return null;
    if (!data.member?.household_id || !Array.isArray(data.rows?.items)) return null;
    return data;
  } catch {
    return null;
  }
}

// SDK 存在 localStorage 的 session。這裡只拿 user（畫頭像與決定讀哪份快取），不拿 token：
// 能不能讀到資料仍然要等 SDK 換好 token、打過 API 才算數。
export function readStoredUser(raw) {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const user = data?.user ?? data?.currentSession?.user ?? null;
    return user?.id ? user : null;
  } catch {
    return null;
  }
}
