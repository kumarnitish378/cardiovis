import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1040 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);

const sceneBox = async () => {
  const b = await page.locator('.scene-wrap').boundingBox();
  return { w: Math.round(b.width), h: Math.round(b.height) };
};

const report = { errors };
report.default = await sceneBox();
await page.screenshot({ path: 'D:/ecg_viz/scratch/layout_default.png' });

await page.click('.trace-mode button:has-text("selected only")');
await page.waitForTimeout(500);
report.selectedOnly = await sceneBox();
await page.screenshot({ path: 'D:/ecg_viz/scratch/layout_selected.png' });

await page.click('.trace-mode button:has-text("hide")');
await page.click('.sidebar-toggle');
await page.waitForTimeout(600);
report.tracesHiddenSidebarCollapsed = await sceneBox();
await page.screenshot({ path: 'D:/ecg_viz/scratch/layout_max.png' });

// Restore and drag the splitter down 120px: the scene must grow by ~120.
await page.click('.sidebar-toggle');
await page.click('.trace-mode button:has-text("12 leads")');
await page.waitForTimeout(400);
const before = await sceneBox();
const sp = await page.locator('.splitter').boundingBox();
await page.mouse.move(sp.x + 200, sp.y + sp.height / 2);
await page.mouse.down();
await page.mouse.move(sp.x + 200, sp.y + sp.height / 2 + 120, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
const after = await sceneBox();
report.dragGrewSceneBy = after.h - before.h;

console.log(JSON.stringify(report, null, 1));
await browser.close();
