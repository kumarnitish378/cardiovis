import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1040 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2400);
await page.evaluate(() => { try { localStorage.clear(); } catch {} });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2400);

const read = (i) => page.locator('.trace-zoom .readout').nth(i).innerText();
const timeSpan = () => read(0);
const gainRead = () => read(1);
const rowsRead = () => read(2);
const out = { errors };

out.initial = { time: await timeSpan(), gain: await gainRead(), rows: await rowsRead() };

// --- independent axes ---------------------------------------------------- //
await page.click('.trace-zoom .axis-group[title="Time axis"] button:has-text("+")');
await page.waitForTimeout(200);
out.afterTimeZoom = { time: await timeSpan(), gain: await gainRead(), rows: await rowsRead() };

await page.click('.trace-zoom .axis-group[title^="Amplitude"] button:has-text("+")');
await page.click('.trace-zoom .axis-group[title^="Amplitude"] button:has-text("+")');
await page.waitForTimeout(200);
out.afterGainZoom = { time: await timeSpan(), gain: await gainRead(), rows: await rowsRead() };

await page.click('.trace-zoom .axis-group[title^="Row height"] button:has-text("+")');
await page.waitForTimeout(250);
out.afterRowZoom = { time: await timeSpan(), gain: await gainRead(), rows: await rowsRead() };

// Rows taller than the panel must make it scrollable, not squash the traces.
out.scrollable = await page.evaluate(() => {
  const el = document.querySelector('.trace-scroll');
  return el.scrollHeight > el.clientHeight + 4;
});
out.canScroll = await page.evaluate(() => {
  const el = document.querySelector('.trace-scroll');
  el.scrollTop = 120;
  return el.scrollTop > 0;
});

// --- shift+wheel = amplitude, plain wheel = time ------------------------- //
const c = await page.locator('.trace-scroll').boundingBox();
await page.mouse.move(c.x + c.width * 0.5, c.y + c.height * 0.4);
const t0 = await timeSpan(), g0 = await gainRead();
await page.keyboard.down('Shift');
await page.mouse.wheel(0, -120);
await page.keyboard.up('Shift');
await page.waitForTimeout(250);
out.shiftWheelChangedOnlyGain = (await timeSpan()) === t0 && (await gainRead()) !== g0;
const g1 = await gainRead();
await page.mouse.wheel(0, -120);
await page.waitForTimeout(250);
out.plainWheelChangedOnlyTime = (await timeSpan()) !== t0 && (await gainRead()) === g1;

// --- area (box) zoom ----------------------------------------------------- //
await page.click('.trace-zoom button:has-text("reset")');
await page.waitForTimeout(250);
await page.click('.trace-zoom button:has-text("box")');
const box = await page.locator('.trace-scroll').boundingBox();
await page.mouse.move(box.x + box.width * 0.30, box.y + 30);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.42, box.y + 70, { steps: 10 });
const bandVisible = await page.locator('.trace-band').isVisible();
await page.mouse.up();
await page.waitForTimeout(350);
out.rubberBandShown = bandVisible;
out.afterAreaZoom = { time: await timeSpan(), gain: await gainRead() };

await page.screenshot({ path: 'D:/ecg_viz/scratch/m3_zoom.png' });

// --- double-click resets ------------------------------------------------- //
await page.click('.trace-zoom button:has-text("box")');       // leave box mode
await page.dblclick('.trace-scroll', { position: { x: 400, y: 40 } });
await page.waitForTimeout(300);
out.afterDoubleClick = { time: await timeSpan(), gain: await gainRead() };
console.log(JSON.stringify(out, null, 1));
await browser.close();
