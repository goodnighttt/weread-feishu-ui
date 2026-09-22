const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript({ path: 'dist/weread-feishu-ui.user.js' });
    await page.goto('https://weread.qq.com/web/reader/24e32400813abbf82g011d29kecc32f3013eccbc87e4b62e', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#wr-feishu-ui-host')?.shadowRoot?.querySelectorAll('.wrf-outline-item').length > 5, null, { timeout: 15000 });
    const fifth = page.locator('.wrf-outline-item').filter({ hasText: /^第五章$/ }).first();
    const rect = await fifth.boundingBox();
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForFunction(() => document.title.includes(' - 第五章 - '), null, { timeout: 15000 });
    await page.waitForTimeout(1800);
    const sample = async () => page.evaluate(() => {
      const root = document.querySelector('#wr-feishu-ui-host')?.shadowRoot;
      const main = root?.querySelector('[data-reader-main]');
      const body = root?.querySelector('[data-reader-body]');
      return { title: root?.querySelector('.wrf-article-title')?.textContent, blocks: body?.children.length, chars: body?.textContent.length, scrollHeight: main?.scrollHeight, scrollTop: main?.scrollTop, nativeCanvases: document.querySelectorAll('.readerChapterContent canvas').length, nativeHeight: document.querySelector('.readerChapterContent')?.scrollHeight };
    });
    console.log('BEFORE', await sample());
    const root = page.locator('#wr-feishu-ui-host').locator('>> shadow=.wrf-reader-main');
    await root.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
    await page.waitForTimeout(2500);
    console.log('AFTER', await sample());
    await page.screenshot({ path: 'chapter5-after-scroll.png' });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
