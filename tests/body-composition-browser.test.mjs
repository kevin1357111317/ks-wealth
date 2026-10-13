import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
let chromium;
try { ({chromium} = await import(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch {}
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium?.executablePath();
test('手機居家卡片收合高度、點擊／鍵盤切換及重繪', {
  skip: !chromium || !executablePath || !existsSync(executablePath) ? '需要 Playwright Chromium' : false,
}, async t => {
  const browser = await chromium.launch({executablePath});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:375,height:812}});
  const css = readFileSync(new URL('../health.css',import.meta.url),'utf8');
  const source = readFileSync(new URL('../body-composition.js',import.meta.url),'utf8');
  await page.setContent(`<style>body{margin:16px;font:16px sans-serif}${css}</style><main id="root"></main>`);
  await page.evaluate(async source => {
    const mod = await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));
    const model = mod.bodyCompositionModel([{id:'a',owner_scope:'husband'}],[{
      checkup_id:'a',metric_key:mod.BODY_COMPOSITION_KEY,
      value_text:JSON.stringify({version:1,conditions:'固定量測',records:[
        {at:'2020-01-01T07:00:00+08:00',weight:50,fatPercent:20,muscleKg:20},
        {at:'2020-01-02T07:00:00+08:00',weight:51,fatPercent:21,muscleKg:21},
      ]}),
    }],'husband');
    window.redrawBody = () => {
      const root=document.querySelector('#root');
      root.innerHTML=mod.renderBodyComposition(model);
      mod.bindBodyComposition(root,model);
    };
    window.redrawBody();
  },source);
  const card=page.locator('[data-body-card]');
  const summary=page.locator('.bodySummary');
  assert.ok((await card.boundingBox()).height < 180);
  assert.equal(await page.locator('.bodyChart').first().isVisible(),false);
  assert.equal(await summary.locator('.bodyPreview>span').count(),3);
  await summary.click();
  await page.waitForFunction(() => document.querySelector('[data-body-card]').open);
  assert.equal(await page.locator('.bodyChart').first().isVisible(),true);
  await page.waitForTimeout(50); // native toggle event updates the session choice
  await page.evaluate(() => window.redrawBody());
  assert.equal(await card.getAttribute('open'),'');
  const slider=page.locator('[data-body-scrub]').first();
  await slider.evaluate(input => {input.value='0';});
  await slider.dispatchEvent('input');
  assert.match(await page.locator('[data-body-output]').first().textContent(),/2020-01-01/);
  await summary.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('[data-body-card]').open);
  assert.equal(await page.locator('.bodyChart').first().isVisible(),false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
});
