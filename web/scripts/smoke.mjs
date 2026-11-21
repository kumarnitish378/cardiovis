import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

const seek = (sample) => page.evaluate((v) => {
  const el = document.querySelector('.scrub');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, String(v));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, sample);

const pickCase = async (label) => {
  const value = await page.evaluate((needle) => {
    const sel = document.querySelector('#case-select');
    const opt = [...sel.options].find(o => o.text.toLowerCase().includes(needle));
    return opt ? opt.value : null;
  }, label);
  if (!value) throw new Error('case not found: ' + label);
  await page.selectOption('#case-select', value);
  await page.waitForTimeout(900);
};

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// Real recording, lead aVR, mid-QRS of beat 2 (R peak at sample 463).
await seek(470);
await page.waitForTimeout(500);
await page.screenshot({ path: 'D:/ecg_viz/scratch/shot_avr_qrs.png' });
const avr = await page.locator('table.kv').first().innerText();

// LBBB, lead V1 - the definition-of-done interaction.
await pickCase('left bundle');
await page.click('.lead-picker button:has-text("V1")');
const lbbbR = await page.evaluate(async () => {
  const res = await fetch('/data/syn_lbbb/frames.json');
  const m = await res.json();
  return m.delineation.beats[2].samples.qrsOn + 40;
});
await seek(lbbbR);
await page.waitForTimeout(600);
await page.screenshot({ path: 'D:/ecg_viz/scratch/shot_lbbb_v1.png' });
const v1 = await page.locator('table.kv').first().innerText();

// Limits tab on the atrial fibrillation case.
await pickCase('atrial fibrillation');
await page.click('.tabs button:has-text("Limits")');
await page.waitForTimeout(500);
await page.screenshot({ path: 'D:/ecg_viz/scratch/shot_afib_limits.png' });
const limits = await page.locator('aside').innerText();

console.log('ERRORS: ' + JSON.stringify(errors));
console.log('--- aVR at QRS ---\n' + avr);
console.log('--- LBBB V1 ---\n' + v1);
console.log('--- AFib limits (first 900 chars) ---\n' + limits.slice(0, 900));
await browser.close();
