import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const readout = () => page.locator('.controls .readout').first().innerText();
const before = await readout();
await page.click('.controls button.primary');        // Play
await page.waitForTimeout(1500);
const during = await readout();
await page.click('.controls button.primary');        // Pause
await page.waitForTimeout(400);
const after = await readout();
await page.waitForTimeout(900);
const afterStill = await readout();   // must be identical: paused means paused

// The 3D canvas must actually change between two instants in the beat.
const pixels = async () => page.locator('canvas').first().screenshot().then(b => b.length + ':' + b.subarray(0, 4000).reduce((a, x) => a + x, 0));
const f1 = await pixels();
await page.click('.controls button[aria-label="Forward 4 ms"]');
for (let i = 0; i < 12; i++) await page.click('.controls button[aria-label="Forward 4 ms"]');
await page.waitForTimeout(400);
const f2 = await pixels();

console.log(JSON.stringify({
  clockAdvancedWhilePlaying: before !== during,
  clockStoppedWhenPaused: after === afterStill,
  sceneChangedBetweenFrames: f1 !== f2,
  before, during, after, afterStill,
  errors,
}, null, 1));
await browser.close();
