// 居家 BIA 與年度健檢分開：原始量測只存於受 RLS 保護的 health_metrics。
export const BODY_COMPOSITION_KEY = 'body_composition_home_v1';
export const BODY_FIELDS = [
  ['weight', '體重', 'kg'], ['fatPercent', '體脂率', '%'],
  ['muscleKg', '骨骼肌量', 'kg'], ['fatKg', '脂肪量', 'kg'],
  ['musclePercent', '骨骼肌率', '%'], ['bmi', 'BMI', ''],
  ['visceral', '內臟脂肪程度', '級'], ['metabolism', '估計基礎代謝', 'kcal'],
  ['bodyAge', '儀器身體年齡', '歲'],
];
const numeric = v => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = v => Number.isFinite(v) ? v.toFixed(1) : '—';
const dateMs = date => Date.parse(`${date}T00:00:00+08:00`);
// Keep the user's choice through live-price rerenders, without persisting health data.
const expandedCards = new Map();

export function bodyCompositionModel(checkups, metrics, ownerScope) {
  const ids = new Set((checkups ?? []).filter(r => r.owner_scope === ownerScope).map(r => r.id));
  const records = [];
  let conditions = '';
  for (const metric of metrics ?? []) {
    if (!ids.has(metric.checkup_id) || metric.metric_key !== BODY_COMPOSITION_KEY) continue;
    try {
      const payload = JSON.parse(metric.value_text);
      if (payload.version !== 1 || !Array.isArray(payload.records)) continue;
      conditions = payload.conditions || conditions;
      for (const row of payload.records) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(row.at) || !Number.isFinite(Date.parse(row.at))) continue;
        const values = Object.fromEntries(BODY_FIELDS.map(([key]) => [key, numeric(row[key])]));
        if (values.weight === null || values.weight <= 0) continue;
        records.push({ at: row.at, date: row.at.slice(0, 10), model: row.model || '', ...values });
      }
    } catch { /* 無效匯入不影響健康／財務首頁。 */ }
  }
  records.sort((a, b) => a.at.localeCompare(b.at));
  const groups = new Map();
  const excluded = records.filter(r => Number(r.at.slice(11, 13)) < 5 || Number(r.at.slice(11, 13)) >= 12);
  for (const row of records) {
    if (excluded.includes(row)) continue;
    if (!groups.has(row.date)) groups.set(row.date, []);
    groups.get(row.date).push(row);
  }
  const daily = [...groups].map(([date, rows]) => ({ date, count: rows.length,
    ...Object.fromEntries(BODY_FIELDS.map(([key]) => {
      const values = rows.map(r => r[key]).filter(Number.isFinite);
      return [key, values.length ? values.reduce((s, v) => s + v, 0) / values.length : null];
    })),
  }));
  return { ownerScope, records, daily, excluded, conditions, latest: records.at(-1) ?? null };
}
function chart(model, key, label, unit) {
  const points = model.daily.filter(r => Number.isFinite(r[key]));
  if (!points.length) return '';
  const start = dateMs(points[0].date), end = dateMs(points.at(-1).date);
  const values = points.map(r => r[key]);
  const pad = Math.max((Math.max(...values) - Math.min(...values)) * .15, .2);
  const min = Math.min(...values) - pad, max = Math.max(...values) + pad;
  const x = d => 44 + 276 * (dateMs(d) - start) / (end - start || 1);
  const y = v => 142 - 112 * (v - min) / (max - min);
  const smooth = points.map(p => {
    const window = points.filter(r => dateMs(r.date) <= dateMs(p.date) && dateMs(r.date) > dateMs(p.date) - 7 * 86400000);
    return { ...p, value: window.reduce((sum, r) => sum + r[key], 0) / window.length };
  });
  const grid = [min, (min + max) / 2, max].map(v => `<line x1="44" x2="320" y1="${y(v)}" y2="${y(v)}" stroke="#dce9e4"/><text x="38" y="${y(v) + 4}" text-anchor="end" fill="#645d58" font-size="10">${fmt(v)}</text>`).join('');
  const dots = points.map(p => `<circle cx="${x(p.date)}" cy="${y(p[key])}" r="2.6" fill="#0057b8" opacity=".5"><title>${p.date}：${fmt(p[key])}${unit}</title></circle>`).join('');
  const last = points.at(-1);
  const delta = last[key] - points[0][key];
  return `<article class="healthTrendCard bodyChart"><div class="healthTrendHead"><span>${label}<b>${fmt(last[key])} ${unit}</b></span><small>較首日 ${delta >= 0 ? '+' : ''}${fmt(delta)} ${key === 'fatPercent' ? '百分點' : unit}</small></div><svg viewBox="0 0 340 180" role="img" aria-label="${label}早晨趨勢：${points[0].date}至${last.date}；每日平均及七日移動平均">${grid}${dots}<polyline points="${smooth.map(p => `${x(p.date)},${y(p.value)}`).join(' ')}" fill="none" stroke="#0057b8" stroke-width="2.5"/><text x="44" y="168" font-size="10" fill="#645d58">${points[0].date.slice(5)}</text><text x="320" y="168" text-anchor="end" font-size="10" fill="#645d58">${last.date.slice(5)}</text></svg><output data-body-output>${last.date}：${fmt(last[key])} ${unit}</output><input data-body-scrub type="range" min="0" max="${points.length - 1}" value="${points.length - 1}" aria-label="選擇${label}量測日期" data-key="${key}" data-unit="${unit}"/><small>拖曳查看每日數值；淡點＝每日平均，實線＝七日平均（有量測的日子）。</small></article>`;
}

export function renderBodyComposition(model) {
  if (!model.latest) return '';
  const latest = model.latest;
  const preview = BODY_FIELDS.slice(0, 3).map(([key, label, unit]) => `<span><small>${label}</small><b>${fmt(latest[key])} ${unit}</b></span>`).join('');
  const metrics = BODY_FIELDS.map(([key, label, unit]) => `<div class="healthValue"><span>${label}</span><b>${fmt(latest[key])} ${unit}</b></div>`).join('');
  const recent = model.daily.slice(-14).reverse().map(r => `<tr><td>${r.date.slice(5)}</td><td>${fmt(r.weight)}</td><td>${fmt(r.fatPercent)}</td><td>${fmt(r.muscleKg)}</td></tr>`).join('');
  return `<details class="bodyComposition" data-body-card${expandedCards.get(model.ownerScope) ? " open" : ""}><summary class="bodySummary"><span class="bodySummaryHead"><strong>居家體組成趨勢</strong><span>${model.records.length} 次量測 <i aria-hidden="true">⌄</i></span></span><span class="bodyPreview">${preview}</span><span class="bodySummaryFoot">最新 ${esc(latest.at.slice(0,16).replace("T"," "))} · <span class="bodyExpandLabel">查看趨勢</span><span class="bodyCollapseLabel">收起內容</span></span></summary><div class="bodyDetails"><p>${esc(model.conditions)}</p><p>${esc(latest.model)} · 最新 ${esc(latest.at.slice(0,16).replace('T',' '))}（台北時間）</p><div class="healthValues">${metrics}</div><p>居家體脂計估計值，不與健檢儀器混算，也不影響年度健康評分；基礎代謝不是每日總熱量需求。</p>${model.excluded.length ? `<p>原始資料有 ${model.excluded.length} 筆非早晨時間，已保留，但未放入早晨趨勢；同日多次量測取平均。</p>` : '<p>早晨量測趨勢；同日多次量測取平均。</p>'}<div class="healthTrendGrid">${BODY_FIELDS.slice(0,3).map(([key,label,unit]) => chart(model,key,label,unit)).join('')}</div><details><summary>最近14個量測日</summary><table><thead><tr><th>日期</th><th>體重kg</th><th>體脂%</th><th>骨骼肌kg</th></tr></thead><tbody>${recent}</tbody></table></details></div></details>`;
}

export function bindBodyComposition(root, model) {
  const card = root.querySelector('[data-body-card]');
  card?.addEventListener('toggle', () => {
    if (card.isConnected) expandedCards.set(model.ownerScope, card.open);
  });
  root.querySelectorAll('[data-body-scrub]').forEach(input => {
    input.addEventListener('input', () => {
      const points = model.daily.filter(r => Number.isFinite(r[input.dataset.key]));
      const p = points[Number(input.value)];
      if (p) input.closest('.bodyChart').querySelector('[data-body-output]').textContent = `${p.date}：${fmt(p[input.dataset.key])} ${input.dataset.unit}`;
    });
  });
}
