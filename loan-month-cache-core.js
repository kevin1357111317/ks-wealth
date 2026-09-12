export const LOAN_MONTH_CACHE_PREFIX = 'ks-loan-month-summary';

export function readStoredAuth(raw) {
  if (!raw) return { accessToken: '', userId: '' };
  try {
    const data = JSON.parse(raw);
    return {
      accessToken: data?.access_token || data?.currentSession?.access_token || '',
      userId: data?.user?.id || data?.currentSession?.user?.id || '',
    };
  } catch {
    return { accessToken: '', userId: '' };
  }
}

export function loanMonthDataKey(userId, owner, loanType, today) {
  if (!userId) return '';
  return `${userId}|${owner}|${loanType}|${today}`;
}

export function loanMonthStorageKey(key) {
  return key ? `${LOAN_MONTH_CACHE_PREFIX}|${key}` : '';
}
