import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(process.env.BB_PLAYWRIGHT_MODULE || import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '_tmp_v950_manager_screens');
const server = createServer(async (req, res) => {
    try {
        const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (path === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/BB-Memory/style.css"><style>body{background:#171923;color:#eee;font:16px system-ui}button,input,textarea,select{font:inherit}button{cursor:pointer;color:inherit;background:#303348;border:1px solid #666;padding:.4em}.bb-input{background:#242638;color:#eee;border:1px solid #666}</style><body></body></html>');
            return;
        }
        const file = resolve(root, '.' + path);
        if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
        res.setHeader('Content-Type', extname(file) === '.js' ? 'text/javascript; charset=utf-8' : extname(file) === '.css' ? 'text/css; charset=utf-8' : 'text/plain; charset=utf-8');
        res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir(output, { recursive: true });
let browser;
try {
    browser = await chromium.launch({ headless: true, ...(process.env.BB_BROWSER_CHANNEL ? { channel: process.env.BB_BROWSER_CHANNEL } : {}) });
    for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 750 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.evaluate(async () => {
            globalThis.fetch = async url => {
                if (url === '/api/users/me') return { ok: true, json: async () => ({ handle: 'manager950', created: 1 }) };
                throw new Error('Unexpected network: ' + url);
            };
            const bank = new Map();
            const localforage = { async getItem(key) { return structuredClone(bank.get(key) ?? null); }, async setItem(key, value) { bank.set(key, structuredClone(value)); return value; }, async removeItem(key) { bank.delete(key); } };
            const ctx = { libs: { localforage }, extensionSettings: {}, chatId: 'manager950', characterId: 0, chat: [], chatMetadata: {}, saveSettingsDebounced() {}, saveMetadataDebounced() {} };
            globalThis.SillyTavern = { getContext: () => ctx };
            globalThis.toastr = { success() {}, warning() {}, info() {}, error() {} };
            const store = await import('/BB-Memory/memory-store.js');
            store.updateSettings({ autoBackupEnabled: false, embeddingEnabled: false, eventTimeOrder: '旧纪元\n新纪元' });
            const first = await store.addMemory(ctx.chatId, { title: '九日记忆', content: '九日内容', storyTime: '旧纪元12年2月9日', importance: 0, tags: [] });
            globalThis.firstId = first.id;
            await store.addMemory(ctx.chatId, { title: '十日记忆', content: '十日内容', storyTime: '旧纪元12年2月10日' });
            await store.addMemory(ctx.chatId, { title: '新纪元记忆', content: '新纪元内容', storyTime: '新纪元1年1月1日' });
            await store.addMemory(ctx.chatId, { title: '无时间记忆', content: '无时间内容' });
            globalThis.line = await store.upsertTimeline(ctx.chatId, { name: '北境远征', entries: [], status: 'ongoing' });
            globalThis.secondLine = await store.upsertTimeline(ctx.chatId, { name: '人物成长', entries: [], status: 'ongoing' });
            globalThis.ms = await store.addMilestone(ctx.chatId, { event: '出征', storyTime: '旧纪元12年2月9日', timelineId: line.id });
            globalThis.ms2 = await store.addMilestone(ctx.chatId, { event: '胜利', storyTime: '新纪元1年1月1日', timelineId: 'deleted-line' });
            const manager = await import('/BB-Memory/memory-manager.js');
            await manager.openMemoryManager(ctx.chatId);
            const time = await import('/BB-Memory/event-time.js');
            if (!(time.compareEventTimes('第九天', '第十天') < 0)) throw new Error('Chinese numbers are not ordered');
            if (!(time.compareEventTimes('旧纪元99年', '新纪元1年', '旧纪元\n新纪元') < 0)) throw new Error('Era order is not honored');
        });
        if (width <= 480) await page.locator('#bb_mgr_controls_toggle').click();
        await page.locator('.bb-mem-type-filter[data-type="mem"]').click();
        await page.waitForFunction(() => document.querySelectorAll('#bb_mgr_list .bb-mem-item').length === 4);
        await page.locator('#bb_mgr_sort').selectOption('event_time_asc');
        await page.waitForFunction(() => document.querySelector('#bb_mgr_list .bb-mem-item strong').textContent === '九日记忆');
        const memoryTitles = () => page.locator('#bb_mgr_list .bb-mem-item > div:first-child > strong').allTextContents();
        assert.deepEqual(await memoryTitles(), ['九日记忆', '十日记忆', '新纪元记忆', '无时间记忆']);
        await page.locator('#bb_mgr_sort').selectOption('event_time_desc');
        await page.waitForFunction(() => document.querySelector('#bb_mgr_list .bb-mem-item strong').textContent === '新纪元记忆');
        assert.deepEqual(await memoryTitles(), ['新纪元记忆', '十日记忆', '九日记忆', '无时间记忆']);
        await page.locator('.bb-mem-item').filter({ hasText: '九日记忆' }).locator('.bb-mem-edit').click();
        assert.equal(await page.locator('.bb-f-storyTime').inputValue(), '旧纪元12年2月9日');
        assert.equal(await page.locator('.bb-f-importance').inputValue(), '0');
        await page.locator('.bb-f-storyTime').fill('旧纪元12年2月11日');
        await page.locator('.bb-f-daily').check();
        await page.locator('.bb-form-save').click();
        await page.waitForSelector('.bb-manager-form-overlay', { state: 'detached' });
        const edited = await page.evaluate(async () => (await (await import('/BB-Memory/memory-store.js')).getMemories('manager950')).find(memory => memory.id === firstId));
        assert.equal(edited.storyTime, '旧纪元12年2月11日');
        assert.ok(edited.tags.includes('日常'));
        assert.equal(edited.importance, 0);
        await page.locator('.bb-mem-type-filter[data-type="milestone"]').click();
        await page.waitForFunction(() => document.querySelectorAll('#bb_mgr_list .bb-mem-item').length === 2);
        await page.locator('.bb-mem-item').filter({ hasText: '出征' }).locator('.bb-mem-edit').click();
        await page.waitForFunction(() => !document.querySelector('.bb-f-timelineId').disabled);
        assert.equal(await page.locator('.bb-f-timelineId').inputValue(), await page.evaluate(() => line.id));
        await page.locator('.bb-f-timelineId').selectOption(await page.evaluate(() => secondLine.id));
        await page.locator('.bb-form-save').click();
        await page.waitForSelector('.bb-manager-form-overlay', { state: 'detached' });
        await page.locator('.bb-mgr-tab[data-tab="threads"]').click();
        await page.waitForSelector('.bb-thread-detail-item');
        assert.equal((await page.locator('.bb-thread-detail-item').filter({ hasText: '胜利' }).locator('.bb-thread-detail-assign').innerText()).trim(), '其他 / 无标签');
        await page.locator('#bb_thread_milestone_all').check();
        await page.locator('#bb_thread_milestone_assign').click();
        await page.locator('.bb-assign-timeline').selectOption(await page.evaluate(() => secondLine.id));
        await page.screenshot({ path: join(output, `assignment-${width}.png`) });
        await page.locator('.bb-timeline-assignment-popup [data-action="save"]').click();
        await page.waitForSelector('.bb-timeline-assignment-popup', { state: 'detached' });
        const milestones = await page.evaluate(async () => (await (await import('/BB-Memory/memory-store.js')).getMilestones('manager950')));
        const lineId = await page.evaluate(() => secondLine.id);
        assert.ok(milestones.every(milestone => milestone.timelineId === lineId));
        await page.locator('#bb_thread_milestone_filter').selectOption(lineId);
        assert.equal(await page.locator('.bb-thread-detail-item:visible').count(), 2);
        await page.locator('#bb_thread_refresh_inline').click();
        assert.equal(await page.locator('.bb-summary-scope option').count(), 4);
        await page.locator('.bb-summary-scope').selectOption('selected_linked');
        assert.equal(await page.locator('.bb-summary-timeline').isVisible(), true);
        await page.locator('.bb-summary-timeline').selectOption(lineId);
        await page.screenshot({ path: join(output, `summary-scope-${width}.png`) });
        const formBounds = await page.locator('.bb-thread-summary-popup').boundingBox();
        assert.ok(formBounds.x >= 0 && formBounds.x + formBounds.width <= width + 1, JSON.stringify(formBounds));
        await page.locator('.bb-thread-summary-popup [data-action="cancel"]').click();
        await page.evaluate(async () => {
            const store = await import('/BB-Memory/memory-store.js');
            await store.removeTimeline('manager950', line.id);
            await store.removeTimeline('manager950', secondLine.id);
        });
        await page.locator('.bb-mgr-tab[data-tab="memories"]').click();
        await page.locator('.bb-mgr-tab[data-tab="threads"]').click();
        await page.waitForSelector('.bb-thread-empty');
        assert.equal(await page.locator('.bb-thread-detail-item').count(), 2);
        assert.equal(await page.locator('.bb-thread-detail-assign').filter({ hasText: '其他 / 无标签' }).count(), 2);
        await page.locator('#bb_thread_refresh_inline').click();
        await page.locator('.bb-summary-scope').selectOption('selected_linked');
        assert.equal(await page.locator('.bb-thread-summary-popup [data-action="generate"]').isDisabled(), true);
        await page.locator('.bb-summary-scope').selectOption('all_with_milestones');
        assert.equal(await page.locator('.bb-thread-summary-popup [data-action="generate"]').isDisabled(), false);
        await page.locator('.bb-thread-summary-popup [data-action="cancel"]').click();
        await page.screenshot({ path: join(output, `unassigned-${width}.png`) });
        assert.deepEqual(errors, []);
        await page.close();
    }
    console.log('v9.5.0 manager browser tests passed at 1280px and 390px');
} finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
}
