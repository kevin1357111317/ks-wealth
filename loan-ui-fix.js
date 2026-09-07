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

function formatLoanTerm(totalPeriods) {
  if (!Number.isFinite(totalPeriods) || totalPeriods <= 0) return '';
  const periods = Math.round(totalPeriods);
  const years = Math.floor(periods / 12);
  const months = periods % 12;
  if (years > 0 && months > 0) return `${periods} 期（${years} 年 ${months} 個月）`;
  if (years > 0) return `${periods} 期（${years} 年）`;
  return `${periods} 期（${months} 個月）`;
}

function metricByLabel(metrics, label) {
  return [...metrics.children].find(item => item.querySelector('span')?.textContent?.trim() === label) || null;
}

function simplifyAndReorderLoanMetrics(scope = document) {
  scope.querySelectorAll('.loanDetail .loanCashflowMetrics').forEach(metrics => {
    // 先從「已繳期數」取得總期數，再移除不需要的欄位。
    const paidItem = metricByLabel(metrics, '已繳期數');
    const paidText = paidItem?.querySelector('b')?.textContent?.trim() || '';
    const totalMatch = paidText.match(/\/\s*(\d+)/);
    const totalPeriods = totalMatch ? Number(totalMatch[1]) : NaN;

    ['下次繳款', '金額', '實收金額'].forEach(label => {
      metricByLabel(metrics, label)?.remove();
    });

    const feeItem = metricByLabel(metrics, '開辦費') || metricByLabel(metrics, '其他費用');
    const feeLabel = feeItem?.querySelector('span');
    if (feeLabel && feeLabel.textContent?.trim() !== '其他費用') feeLabel.textContent = '其他費用';

    const termText = formatLoanTerm(totalPeriods);
    let termItem = metrics.querySelector('[data-loan-term]');
    if (termText) {
      if (!termItem) {
        termItem = document.createElement('div');
        termItem.dataset.loanTerm = 'true';
        termItem.innerHTML = '<span>貸款年限</span><b></b>';
        metrics.append(termItem);
      }
      const termValue = termItem.querySelector('b');
      if (termValue && termValue.textContent !== termText) termValue.textContent = termText;
    }

    // 展開後只留真正需要快速掌握的摘要，常用資訊優先。
    const desiredLabels = ['已繳期數', '貸款年限', '剩餘應還', '過往已繳', '其他費用', '全期利息與費用'];
    const currentLabels = [...metrics.children].map(item => item.querySelector('span')?.textContent?.trim() || '');
    const desiredItems = desiredLabels.map(label => metricByLabel(metrics, label)).filter(Boolean);
    const desiredCurrentLabels = desiredItems.map(item => item.querySelector('span')?.textContent?.trim() || '');

    if (currentLabels.join('|') !== desiredCurrentLabels.join('|')) {
      desiredItems.forEach(item => metrics.append(item));
    }
  });
}

function reorderLoanCardFacts(scope = document) {
  scope.querySelectorAll('.loanCard .loanFacts').forEach(facts => {
    // 目前本金餘額已經獨立放大顯示；其餘欄位依一般貸款閱讀習慣排序。
    const priorities = new Map([
      ['每月月付', 10],
      ['總還款', 10],
      ['表定利率', 20],
      ['原貸款', 30],
      ['預計到期', 40],
      ['結清日期', 40],
      ['實際年化成本', 50],
      ['全期利息與費用', 60],
    ]);

    const items = [...facts.children];
    const sorted = [...items].sort((a, b) => {
      const aLabel = a.querySelector('span')?.textContent?.trim() || '';
      const bLabel = b.querySelector('span')?.textContent?.trim() || '';
      return (priorities.get(aLabel) ?? 999) - (priorities.get(bLabel) ?? 999);
    });

    const unchanged = items.every((item, index) => item === sorted[index]);
    if (!unchanged) sorted.forEach(item => facts.append(item));
  });
}

function setSimpleRowLabel(row, label) {
  const left = row.children[0];
  const right = row.children[1];
  if (!left || !right) return;

  const leftNotes = [...left.querySelectorAll('small')];
  const rightNotes = [...right.querySelectorAll('small')];
  const amount = right.querySelector('b');

  // 已經是目標狀態就完全不碰 DOM，避免 MutationObserver 自己觸發自己造成無限重繪。
  const alreadySimple = leftNotes.length === 0
    && rightNotes.length === 1
    && rightNotes[0].textContent?.trim() === label;
  if (alreadySimple) return;

  leftNotes.forEach(node => node.remove());
  rightNotes.forEach(node => node.remove());

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
  simplifyAndReorderLoanMetrics(scope);
  reorderLoanCardFacts(scope);
  simplifyLoanRows(scope);
}

applyLoanUiFixes();

if (root) {
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      applyLoanUiFixes(root);
    });
  });
  observer.observe(root, { childList: true, subtree: true });
}
