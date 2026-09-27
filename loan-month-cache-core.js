export const LOAN_MONTH_CACHE_PREFIX = 'ks-loan-month-summary';

export function readStoredAuth(raw) {
  if (!raw) return { accessToken: '', userId: '', expiresAt: 0 };
  try {
    const data = JSON.parse(raw);
    return {
      accessToken: data?.access_token || data?.currentSession?.access_token || '',
      userId: data?.user?.id || data?.currentSession?.user?.id || '',
      expiresAt: Number(data?.expires_at || data?.currentSession?.expires_at || 0),
    };
  } catch {
    return { accessToken: '', userId: '', expiresAt: 0 };
  }
}

// expires_at 是 SDK 存的秒數。沒有這個欄位時當作可用（舊格式），留 10 秒餘裕避免送出去
// 的途中剛好過期。
export function isStoredAuthFresh(auth, nowMs = Date.now()) {
  if (!auth?.accessToken) return false;
  return !auth.expiresAt || auth.expiresAt * 1000 > nowMs + 10_000;
}

export function loanMonthDataKey(userId, owner, loanType, today) {
  if (!userId) return '';
  return `${userId}|${owner}|${loanType}|${today}`;
}

export function loanMonthStorageKey(key) {
  return key ? `${LOAN_MONTH_CACHE_PREFIX}|${key}` : '';
}
