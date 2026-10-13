import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_COMPOSITION_KEY, bodyCompositionModel, renderBodyComposition } from '../body-composition.js';
const reports = [{id:'a',owner_scope:'husband'}, {id:'b',owner_scope:'wife'}];
const entry = (id, records) => ({checkup_id:id,metric_key:BODY_COMPOSITION_KEY,value_text:JSON.stringify({version:1,conditions:'固定量測',records})});
const row = (at, weight) => ({at,weight,fatPercent:20,muscleKg:20,model:'sample'});
test('居家量測只讀自己的 scope，保留原始筆數，同日取平均並排除晚間', () => {
  const metrics = [entry('a',[row('2020-01-01T07:00:00+08:00',50),row('2020-01-01T07:01:00+08:00',52),row('2020-01-02T23:00:00+08:00',60)]),entry('b',[row('2020-01-01T07:00:00+08:00',80)])];
  const model = bodyCompositionModel(reports,metrics,'husband');
  assert.equal(model.records.length,3);
  assert.equal(model.daily.length,1);
  assert.equal(model.daily[0].weight,51);
  assert.equal(model.excluded.length,1);
  assert.equal(model.daily[0].bmi,null);
  assert.match(renderBodyComposition(model),/data-body-scrub/);
  assert.match(renderBodyComposition(model),/不影響年度健康評分/);
});
test('缺測、空資料與壞 JSON 不讓健康畫面失效', () => {
  assert.equal(renderBodyComposition(bodyCompositionModel(reports,[{checkup_id:'a',metric_key:BODY_COMPOSITION_KEY,value_text:'bad'}],'husband')),'');
  assert.equal(bodyCompositionModel(reports,[entry('a',[row('invalid',50)])],'husband').records.length,0);
});
test('原始文案與機型需 escape，圖表無 NaN，測量日不要求連續', () => {
  const metric=entry('a',[row('2020-01-01T08:00:00+08:00',50),{...row('2020-03-01T08:00:00+08:00',50),model:'<script>'}]);
  const html=renderBodyComposition(bodyCompositionModel(reports,[metric],'husband'));
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('<script>'));
  assert.match(html,/&lt;script&gt;/);
});
