const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const bundle = path.resolve(__dirname, '../dist/weread-feishu-ui.user.js');
const url = 'https://weread.qq.com/web/reader/24e32400813abbf82g011d29kecc32f3013eccbc87e4b62e';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const logs = [];
    page.on('console', message => { if (message.text().includes('[目录跳转]')) logs.push(message.text()); });
    await page.addInitScript({ path: bundle });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-wrf-native-hit]').length > 2);
    // SSR already contains the catalog before the site's handlers are hydrated.
    await page.waitForFunction(() => [...document.querySelectorAll('.readerChapterContent canvas')].some(canvas => canvas.width > 20));
    await page.waitForTimeout(1200);

    async function pointFor(title) {
      const visual = page.locator('.wrf-outline-item').filter({ hasText: new RegExp(`^${title}$`) });
      await visual.evaluate(el => el.scrollIntoView({ block: 'nearest' }));
      await page.waitForFunction(title => {
        const root = document.querySelector('#wr-feishu-ui-host')?.shadowRoot;
        const visual = [...root.querySelectorAll('.wrf-outline-item')].find(el => el.textContent === title);
        const r = visual.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit?.closest('[data-wrf-native-hit]')?.querySelector('.readerCatalog_list_item_title_text')?.textContent === title;
      }, title, { timeout: 8000 });
      const rect = await visual.boundingBox();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    async function navigate(title) {
      const before = page.url();
      const point = await pointFor(title);
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(({ title, before }) => location.href !== before && document.title.includes(` - ${title} - `)
        && document.querySelector('#wr-feishu-ui-host')?.shadowRoot?.querySelector('.wrf-article-title')?.textContent === title,
      { title, before }, { timeout: 15000 }).catch(async error => {
        console.log('NAV DIAGNOSTIC', await page.evaluate(()=>({title:document.title,url:location.href,heading:document.querySelector('#wr-feishu-ui-host').shadowRoot.querySelector('.wrf-article-title').textContent,native:[...document.querySelectorAll('[class*=chapterTitle]')].map(e=>e.textContent),components:[...document.querySelectorAll('.readerCatalog,.wr_horizontalReader,.readerChapterContent')].map(e=>({cls:e.className,data:Object.fromEntries(Object.entries(e.__vue__?.$data||{}).filter(([k,v])=>typeof v==='boolean'||/loading|render|pending/i.test(k)).map(([k,v])=>[k,typeof v==='object'?Object.keys(v||{}):v]))}))})),logs.slice(-5));
        throw error;
      });
      await page.waitForFunction(() => {
        const body = document.querySelector('#wr-feishu-ui-host')?.shadowRoot?.querySelector('[data-reader-body]');
        // The horizontal reader paints fewer characters at narrow widths.
        return body && !body.querySelector('.wrf-article-loading') && body.textContent.length > 40;
      }, null, {timeout: 8000});
      const content = await page.locator('[data-reader-body]').textContent();
      console.log('PASS native hit + real route + displayed title:', title);
      return createHash('sha256').update(content).digest('hex');
    }
    const second = await navigate('第二章');
    const third = await navigate('第三章');
    assert.notEqual(second, third, 'Chapter bodies must differ');
    await navigate('第一章');
    await navigate('第二章');
    const secondUrl = page.url();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#wr-feishu-ui-host')?.shadowRoot?.querySelector('.wrf-article-title')?.textContent === '第二章');
    assert.equal(page.url(), secondUrl, 'Reload must retain the chapter URL');
    console.log('PASS reload stays on second chapter');

    await page.setViewportSize({ width: 1000, height: 650 });
    // Wait for the site's own asynchronous canvas repagination after resize.
    await page.waitForTimeout(1200);
    let point = await pointFor('第三章');
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 260);
    await page.waitForFunction(() => document.querySelector('#wr-feishu-ui-host').shadowRoot.querySelector('.wrf-reader-outline').scrollTop > 0);
    await navigate('第三章');
    console.log('PASS resize and outline wheel scrolling');

    await page.locator('.wrf-toc-toggle').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-wrf-native-hit]').length === 0);
    await page.locator('.wrf-toc-toggle').click();
    await navigate('第二章');
    await page.keyboard.press('Alt+f');
    await page.waitForFunction(() => !document.documentElement.classList.contains('wrf-enabled') && !document.querySelector('[data-wrf-native-hit-panel]'));
    await page.locator('.readerControls_item.catalog').click();
    await page.locator('.readerCatalog_list_item_inner').filter({ hasText: /^第一章/ }).first().click();
    await page.waitForFunction(() => document.title.includes(' - 第一章 - '));
    await page.waitForTimeout(1200);
    await page.keyboard.press('Alt+f');
    await navigate('第二章');
    console.log('PASS hide/reopen and restore original catalog');

    await page.keyboard.press('Alt+f');
    const mode = page.locator('.readerControls_item.isHorizontalReader');
    if (await mode.count()) {
      await mode.click();
      await page.waitForTimeout(1200);
      await page.keyboard.press('Alt+f');
      await navigate('第三章');
      console.log('PASS vertical reader navigation');
    } else {
      await page.keyboard.press('Alt+f');
    }

    assert.ok(logs.some(text => text.includes('原生目录收到真实点击')));
    assert.ok(logs.some(text => text.includes('已确认目标章节')));
    assert.ok(!logs.some(text => text.includes('未命中原生目录')), logs.join('\n'));
    assert.equal(await page.locator('#wr-feishu-ui-host').count(), 1);
    for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
      assert.equal(await frame.locator('#wr-feishu-ui-host').count(), 0, 'No theme inside embedded frames');
    }
    console.log('PASS trusted input, no fallback, iframe isolation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
