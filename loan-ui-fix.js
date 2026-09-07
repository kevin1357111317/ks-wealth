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

function setSimpleRowLabel(row, label) {
  const left = row.children[0];
  const right = row.children[1];
  if (!left || !right) return;

  // 日期欄只保留實際顯示日期，不再顯示應繳日、假日順延等附註。
  left.querySelectorAll('small').forEach(node => node.remove());

  // 右側只保留簡短標籤與金額，移除核對、順延、繳後本金等說明。
  const amount = right.querySelector('b');
  right.querySelectorAll('small').forEach(node => node.remove());

  const note = document.createElement('small');
  note.textContent = label;
  if (amount) right.insertBefore(note, amount);
  else right.prepend(note);
}

function simplifyLoanRows(scope = document) {
  scope.querySelectorAll('.loanDetail').forEach(detail => {
    const sections = [...detail.querySelectorAll(':scope > .loanFlowSection')];
    const pastSection = sections.find(section => section.querySelector(':scope > .sectionHead span')?.textContent?.trim() === '過往實際繳款');
    const pastCount = pastSection?.querySelectorAll('.loanPlan > .loanPlanRow').length ?? 0;

    sections.forEach(section => {
      const sectionLabel = section.querySelector(':scope > .sectionHead span')?.textContent?.trim();
      const rows = [...section.querySelectorAll('.loanPlan > .loanPlanRow')];

      if (sectionLabel === '過往實際繳款') {
        rows.forEach((row, index) => setSimpleRowLabel(row, `第 ${index + 1} 期`));
        return;
      }

      if (sectionLabel === '未來還款排程') {
        rows.forEach((row, index) => setSimpleRowLabel(row, `第 ${pastCount + index + 1} 期`));
        return;
      }

      if (sectionLabel === '撥款／資金流入') {
        rows.forEach(row => setSimpleRowLabel(row, '撥款'));
      }
    });
  });
}

function applyLoanUiFixes(scope = document) {
  fixLoanSectionCounters(scope);
  simplifyLoanRows(scope);
}

applyLoanUiFixes();

if (root) {
  const observer = new MutationObserver(() => applyLoanUiFixes(root));
  observer.observe(root, { childList: true, subtree: true });
}
