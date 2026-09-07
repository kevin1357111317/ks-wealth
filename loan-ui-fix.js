const root = document.querySelector('#root');

function fixLoanSectionCounters(scope = document) {
  scope.querySelectorAll('.loanFlowSection > .sectionHead').forEach(head => {
    const label = head.querySelector('span')?.textContent?.trim();
    if (label !== '開辦費明細') return;

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
