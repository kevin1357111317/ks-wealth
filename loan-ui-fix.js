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

fixLoanSectionCounters();

if (root) {
  const observer = new MutationObserver(() => fixLoanSectionCounters(root));
  observer.observe(root, { childList: true, subtree: true });
}
