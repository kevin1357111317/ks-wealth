const root = document.querySelector('#root');

function fixLoanSectionCounters(scope = document) {
  scope.querySelectorAll('.loanFlowSection > .sectionHead').forEach(head => {
    const labelNode = head.querySelector('span');
    const label = labelNode?.textContent?.trim();
    if (label !== '開辦費明細' && label !== '其他費用') return;

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
  if (years > 0 && months > 0) return `${years} 年 ${months} 個月`;
  if (years > 0) return `${years} 年`;
  return `${months} 個月`;
}

function metricByLabel(metrics, label) {
  return [...metrics.children].find(item => item.querySelector('span')?.textContent?.trim() === label) || null;
}

function ensureMetric(metrics, label, value) {
  if (!metrics || !label || !value) return;
  let item = metricByLabel(metrics, label);
  if (!item) {
    item = document.createElement('div');
    item.dataset.loanMovedMetric = label;
    item.innerHTML = '<span></span><b></b>';
    metrics.append(item);
  }
  const labelNode = item.querySelector('span');
  const valueNode = item.querySelector('b');
  if (labelNode && labelNode.textContent !== label) labelNode.textContent = label;
  if (valueNode && valueNode.textContent !== value) valueNode.textContent = value;
}

function moveCardFactsToExpandedDetail(scope = document) {
  scope.querySelectorAll('.loanCard').forEach(card => {
    const facts = card.querySelector('.loanCardTap .loanFacts');
    if (!facts) return;

    const findFact = label => [...facts.children].find(item => item.querySelector('span')?.textContent?.trim() === label) || null;

    const statedItem = findFact('表定利率');
    const annualItem = findFact('實際年化成本') || findFact('實際年化利率');
    const combinedItem = findFact('表定利率；實際年化利率');

    if (!combinedItem && statedItem && annualItem) {
      const statedValue = statedItem.querySelector('b')?.textContent?.trim() || '—';
      const annualValue = annualItem.querySelector('b')?.textContent?.trim() || '—';
      const labelNode = statedItem.querySelector('span');
      const valueNode = statedItem.querySelector('b');
      if (labelNode) labelNode.textContent = '表定利率；實際年化利率';
      if (valueNode) valueNode.textContent = `${statedValue} ; ${annualValue}`;
      annualItem.remove();
    }

    const detailMetrics = card.querySelector(':scope > .loanDetail .loanCashflowMetrics');
    const moveLabels = ['原貸款', '預計到期', '結清日期', '總還款', '全期利息與費用'];
    if (detailMetrics) {
      moveLabels.forEach(label => {
        const item = findFact(label);
        const value = item?.querySelector('b')?.textContent?.trim();
        if (value) ensureMetric(detailMetrics, label, value);
      });
    }

    // 第一層只留每月月付與合併後的利率；目前本金餘額仍維持卡片主數字。
    const keepLabels = new Set(['每月月付', '表定利率；實際年化利率']);
    [...facts.children].forEach(item => {
      const label = item.querySelector('span')?.textContent?.trim() || '';
      if (!keepLabels.has(label)) item.remove();
    });

    const ordered = ['每月月付', '表定利率；實際年化利率']
      .map(label => [...facts.children].find(item => item.querySelector('span')?.textContent?.trim() === label))
      .filter(Boolean);
    const current = [...facts.children];
    const unchanged = current.length === ordered.length && current.every((item, index) => item === ordered[index]);
    if (!unchanged) ordered.forEach(item => facts.append(item));

    // 已償還本金百分比屬於次要資訊，而且使用者已要求不要重複顯示已繳／剩餘類資訊。
    card.querySelector('.loanCardTap > .loanFoot')?.remove();
  });
}

function simplifyAndReorderLoanMetrics(scope = document) {
  scope.querySelectorAll('.loanDetail .loanCashflowMetrics').forEach(metrics => {
    const paidItem = metricByLabel(metrics, '已繳期數');
    const paidText = paidItem?.querySelector('b')?.textContent?.trim() || '';
    const totalMatch = paidText.match(/\/\s*(\d+)/);
    const totalPeriods = totalMatch ? Number(totalMatch[1]) : NaN;

    ['下次繳款', '金額', '實收金額', '剩餘應還', '過往已繳'].forEach(label => {
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

    // 展開卡片承接第一層移出的貸款基本資料與總成本資訊。
    const desiredLabels = [
      '原貸款',
      '貸款年限',
      '已繳期數',
      '預計到期',
      '結清日期',
      '總還款',
      '其他費用',
      '全期利息與費用',
    ];
    const desiredItems = desiredLabels.map(label => metricByLabel(metrics, label)).filter(Boolean);
    const currentItems = [...metrics.children];
    const unchanged = currentItems.length === desiredItems.length
      && currentItems.every((item, index) => item === desiredItems[index]);

    if (!unchanged) desiredItems.forEach(item => metrics.append(item));
  });
}

function setSimpleRowLabel(row, label) {
  const left = row.children[0];
  const right = row.children[1];
  if (!left || !right) return;

  const leftNotes = [...left.querySelectorAll('small')];
  const rightNotes = [...right.querySelectorAll('small')];
  const amount = right.querySelector('b');

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

function keepLoanExpansionDownward() {
  if (!root) return;

  // app-v3 會在點擊信貸卡片時整頁重繪並做錨點補正；
  // 開啟卡片時改成鎖住原本的 scrollY，讓新增內容只往卡片下方長出，不把畫面往上拉。
  root.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('[data-loan-account]');
    if (!button) return;
    const card = button.closest('.loanCard');
    if (card?.classList.contains('open')) return;

    const scrollY = window.scrollY;
    const restore = () => window.scrollTo({ top: scrollY, left: 0, behavior: 'auto' });

    requestAnimationFrame(() => {
      restore();
      // UI 精簡程式會在下一個 frame 再調整 DOM，因此再鎖一次位置，避免 iOS Safari 二次回彈。
      requestAnimationFrame(restore);
    });
  }, true);
}

function applyLoanUiFixes(scope = document) {
  fixLoanSectionCounters(scope);
  moveCardFactsToExpandedDetail(scope);
  simplifyAndReorderLoanMetrics(scope);
  simplifyLoanRows(scope);
}

keepLoanExpansionDownward();
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
