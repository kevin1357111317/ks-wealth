const INSURANCE_NOTE_PREFIX = 'KS_INSURANCE_V1:';

const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const stringOrNull = value => {
  const text = String(value ?? '').trim();
  return text || null;
};

export function decodeInsuranceNote(notes) {
  if (typeof notes !== 'string' || !notes.startsWith(INSURANCE_NOTE_PREFIX)) return null;
  try {
    const payload = JSON.parse(notes.slice(INSURANCE_NOTE_PREFIX.length));
    if (payload?.v !== 1 || !Array.isArray(payload.policies)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function insurancePoliciesFromItems(items, ownerScope) {
  return (items ?? [])
    .filter(item => item?.kind === 'asset' && item?.category === '保險' && item?.owner_scope === ownerScope)
    .flatMap(item => {
      const payload = decodeInsuranceNote(item.notes);
      return (payload?.policies ?? []).map((policy, index) => ({
        id: stringOrNull(policy.id) ?? `${item.id}:${index}`,
        itemId: item.id,
        insurer: stringOrNull(policy.insurer) ?? item.name,
        policyNo: stringOrNull(policy.policyNo),
        name: stringOrNull(policy.name) ?? item.name,
        type: stringOrNull(policy.type) ?? '其他',
        status: policy.status === 'active_paying' ? 'active_paying' : 'active_paid_up',
        owner: stringOrNull(policy.owner),
        insured: stringOrNull(policy.insured),
        currency: policy.currency === 'USD' ? 'USD' : 'TWD',
        faceAmount: numberOrNull(policy.faceAmount),
        cashValue: numberOrNull(policy.cashValue),
        cashValueCurrency: policy.cashValueCurrency === 'USD' ? 'USD' : 'TWD',
        annualPremium: numberOrNull(policy.annualPremium),
        riderAnnualPremium: numberOrNull(policy.riderAnnualPremium),
        nextDue: stringOrNull(policy.nextDue),
        startDate: stringOrNull(policy.startDate),
        endDate: stringOrNull(policy.endDate),
        paymentTerm: stringOrNull(policy.paymentTerm),
        coverage: Array.isArray(policy.coverage) ? policy.coverage.map(String) : [],
        coverageSummary: stringOrNull(policy.coverageSummary),
        missing: Array.isArray(policy.missing) ? policy.missing.map(String) : [],
      }));
    })
    .sort((a, b) => (a.nextDue ?? '9999').localeCompare(b.nextDue ?? '9999')
      || a.insurer.localeCompare(b.insurer, 'zh-Hant'));
}

export function calculateInsuranceSummary(items, ownerScope) {
  const insuranceItems = (items ?? []).filter(item =>
    item?.kind === 'asset' && item?.category === '保險' && item?.owner_scope === ownerScope);
  const policies = insurancePoliciesFromItems(insuranceItems, ownerScope);
  const paying = policies.filter(policy => policy.status === 'active_paying');
  const knownAnnualPremium = paying.reduce((sum, policy) =>
    sum + (policy.annualPremium ?? 0) + (policy.riderAnnualPremium ?? 0), 0);
  const unknownPremiumPolicies = paying.filter(policy => policy.annualPremium === null).length;
  const coverage = new Set(policies.flatMap(policy => policy.coverage));

  return {
    policies,
    activePolicies: policies.length,
    payingPolicies: paying.length,
    paidUpPolicies: policies.length - paying.length,
    knownAnnualPremium,
    unknownPremiumPolicies,
    cashValueTwd: insuranceItems.reduce((sum, item) => sum + (Number(item.amount_twd) || 0), 0),
    missingFields: policies.reduce((sum, policy) => sum + policy.missing.length, 0),
    coverage,
  };
}

export { INSURANCE_NOTE_PREFIX };
