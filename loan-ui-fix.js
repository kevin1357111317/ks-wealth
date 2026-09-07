const root = document.querySelector('#root');

function fixLoanSectionCounters(scope = document) {
  scope.querySelectorAll('.loanFlowSection > .sectionHead').forEach(head => {
    const labelNode = head.querySelector('span');
    const label = labelNode?.textContent?.trim();
    if (label !== '開辦費明細' && label !== '其他費用') return;

    // 大項統一顯示「其他費用」；細項仍保留實際費用名稱（開辦費、火災險等）。
    if (labelNode && label !== '其他費用') labelNode.textContent = '其他費用';

    const section = head.closest('.loanFlowSection');
    const count = section?.querySelectorAll('.loanPlan > *').length ?? 0;
    const counter = head.querySelector('b');
    if (!counter || count <= 0) return;

    const text = `${count} 筆`;
    if (counter.textContent !== text) counter.textContent = text;
  });
}

function simplifyPastPaymentRows(scope = document) {
  scope.querySelectorAll('.loanFlowSection').forEach(section => {
    const sectionLabel = section.querySelector(':scope > .sectionHead span')?.textContent?.trim();
    if (sectionLabel !== '過往實際繳款') return;

    section.querySelectorAll('.loanPlan > .loanPlanRow').forEach((row, index) => {
      const left = row.children[0];
      const right = row.children[1];
      if (!left || !right) return;

      // 左側只保留實際繳款日期，不再顯示應繳日／假日順延等說明。
      left.querySelectorAll('small').forEach(node => node.remove());

      // 右側只保留「第 N 期」與實際繳款金額，不顯示核對備註、順延原因、繳後本金等資訊。
      const expected = `第 ${index + 1} 期`;
      const amount = right.querySelector('b');
      const notes = [...right.querySelectorAll('small')];
      const alreadySimple = notes.length === 1 && notes[0].textContent?.trim() === expected;

      if (!alreadySimple) {
        notes.forEach(node => node.remove());
        const period = document.createElement('small');
        period.textContent = expected;
        if (amount) right.insertBefore(period, amount);
        else right.prepend(period);
      }
    });
  });
}

function applyLoanUiFixes(scope = document) {
  fixLoanSectionCounters(scope);
  simplifyPastPaymentRows(scope);
}

applyLoanUiFixes();

if (root) {
  const observer = new MutationObserver(() => applyLoanUiFixes(root));
  observer.observe(root, { childList: true, subtree: true });
}
