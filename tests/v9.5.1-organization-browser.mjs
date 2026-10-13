import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.BB_PLAYWRIGHT_MODULE || import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '_tmp_v951_organization_screens');
const server = createServer(async (req, res) => {
    try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/BB-Memory/style.css"><style>body{margin:0;background:#171923;color:#eee;font:16px system-ui}button,input,textarea,select{font:inherit}button{cursor:pointer;color:inherit;background:#303348;border:1px solid #666;padding:.4em}.bb-input{background:#242638;color:#eee;border:1px solid #666}</style><body></body></html>'); return;
        }
        if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
        const file = resolve(root, '.' + pathname);
        if (!file.startsWith(resolve(root) + sep)) { res.writeHead(403).end(); return; }
        res.setHeader('Content-Type', extname(file) === '.js' ? 'text/javascript; charset=utf-8' : extname(file) === '.css' ? 'text/css; charset=utf-8' : 'text/plain; charset=utf-8');
        res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir(output, { recursive: true });
const state = page => page.evaluate(async () => { const s = await import('/BB-Memory/memory-store.js'); return { timeline: await s.getTimeline('organization951'), milestones: await s.getMilestones('organization951') }; });
const review = page => page.locator('#bb_curate_review_overlay');
const waitIdle = page => page.waitForFunction(() => !document.querySelector('#bb_thread_ai_tags')?.disabled);
const closeReview = async page => { await review(page).locator('.bb-active-review-close').click(); await review(page).waitFor({ state: 'detached' }); };
const selectAll = async page => { for (const input of await review(page).locator('.bb-curate-select').all()) await input.check(); };
const editTag = async (page, index, value) => {
    const card = review(page).locator('.bb-active-review-item').nth(index);
    await card.locator('.bb-curate-editor summary').click();
    const select = card.getByRole('combobox', { name: '所属时间线', exact: true });
    if (value !== undefined) {
        await select.focus(); await select.selectOption(value);
        assert.ok(await select.evaluate(element => document.activeElement === element), 'Changing the tag must preserve the dropdown focus');
    }
    const targetName = await select.locator('option:checked').innerText();
    assert.ok((await card.locator('.bb-curate-diff').innerText()).includes(targetName), 'Result preview must show the selected timeline name');
    assert.ok((await card.locator('.bb-curate-warn').innerText()).includes('→ ' + targetName), 'Tag migration note must show the selected timeline name');
    await select.scrollIntoViewIfNeeded(); return select;
};
const layout = async (page, width) => {
    const bounds = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, panels: [...document.querySelectorAll('.bb-active-review-panel, .bb-organization-popup, #bb_curate_review_overlay select')].map(element => element.getBoundingClientRect().toJSON()) }));
    assert.ok(bounds.document <= width + 1, JSON.stringify(bounds));
    for (const panel of bounds.panels) assert.ok(panel.x >= -1 && panel.right <= width + 1, JSON.stringify(bounds));
};
let browser, activePage;
try {
    browser = await chromium.launch({ headless: true, ...(process.env.BB_BROWSER_CHANNEL ? { channel: process.env.BB_BROWSER_CHANNEL } : {}) });
    for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 760 } }), errors = [];
        activePage = page; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.evaluate(async () => {
            const bank = new Map();
            const lf = { async getItem(k) { return structuredClone(bank.get(k) ?? null); }, async setItem(k, v) { bank.set(k, structuredClone(v)); return v; }, async removeItem(k) { bank.delete(k); } };
            const ctx = { chatId: 'organization951', characterId: 0, chat: [], chatMetadata: {}, extensionSettings: {}, libs: { localforage: lf }, saveSettingsDebounced() {}, saveMetadataDebounced() {} };
            globalThis.SillyTavern = { getContext: () => ctx }; globalThis.toasts = [];
            globalThis.toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(type => [type, message => toasts.push({ type, message })]));
            globalThis.fetch = async url => { if (url === '/api/users/me') return { ok: true, json: async () => ({ handle: 'organization951', created: 1 }) }; throw new Error('Unexpected network: ' + url); };
            const s = await import('/BB-Memory/memory-store.js'); s.updateSettings({ autoBackupEnabled: false, embeddingEnabled: false, timelineCompressionApi: 'main' });
            globalThis.t1 = await s.upsertTimeline(ctx.chatId, { id: 'timeline-date', name: '公园见面约定', summary: 'A 与 B 相约公园', lastSummarizedAt: 1700000000000, entries: [{ period: '第九天', event: '约定一起到公园见面', status: 'ongoing' }] });
            globalThis.t2 = await s.upsertTimeline(ctx.chatId, { id: 'timeline-walk', name: '公园游玩', summary: 'A 与 B 在公园散步', entries: [{ period: '第十天', event: '一起游玩公园', status: 'ongoing' }] });
            globalThis.t3 = await s.upsertTimeline(ctx.chatId, { id: 'timeline-love', name: 'A 与 B 的感情线', parentThreadId: t2.id, type: 'emotional', entries: [{ period: '第十一天', event: '彼此表达关心', status: 'ongoing' }] });
            await s.upsertTimeline(ctx.chatId, { id: t1.id, tags: ['约定'] }); await s.upsertTimeline(ctx.chatId, { id: t2.id, tags: [{ name: '公园', weight: 0.7 }] });
            globalThis.m1 = await s.addMilestone(ctx.chatId, { id: 'milestone-unassigned', event: '讨论到公园见面', storyTime: '第九天', timelineId: '' });
            globalThis.m2 = await s.addMilestone(ctx.chatId, { id: 'milestone-walk', event: '在公园赏花', storyTime: '第十天', timelineId: t2.id });
            globalThis.m3 = await s.addMilestone(ctx.chatId, { id: 'milestone-date', event: '确认约定', storyTime: '第九天', timelineId: t1.id });
            globalThis.requests = []; globalThis.aiMode = 'tags';
            ctx.generateRaw = async ({ prompt }) => {
                if (aiMode === 'summary') {
                    const source = JSON.parse(prompt.replace(/\r\n/g, '\n').split('（当前片段）\n')[1].split('\n## 本次执行约束')[0]); requests.push({ mode: aiMode, source });
                    return JSON.stringify({ timeline: source.timeline.map(t => ({ id: t.id, summary: '已采纳的新总结', entries: t.entries.map((e, i) => ({ period: e.period, event: e.event + ' 已总结', sourceIndices: [i] })) })), milestones: [] });
                }
                const source = JSON.parse(prompt.replace(/\r\n/g, '\n').split('## 完整时间线与里程碑资料\n')[1].split('\n## 输出规范')[0]); requests.push({ mode: aiMode, source }); await new Promise(resolve => setTimeout(resolve, 40));
                if (aiMode === 'tags') return JSON.stringify({ assignments: [{ milestoneId: m1.id, timelineId: t1.id, reason: '为讨论见面的里程碑补上标签' }, { milestoneId: m2.id, timelineId: t1.id, reason: '建议把赏花归入见面约定' }] });
                return JSON.stringify({ merges: [{ ids: [t1.id, t2.id], keepId: t1.id, result: { name: 'A 与 B 的公园之行', summary: '约定后赴公园游玩', type: 'plot', status: 'ongoing', priority: 'medium' }, reason: '相约与实际游玩组成完整公园之行' }] });
            };
            await (await import('/BB-Memory/memory-manager.js')).openMemoryManager(ctx.chatId);
        });
        await page.locator('.bb-mgr-tab[data-tab="threads"]').click(); await page.locator('#bb_thread_ai_tags').waitFor();
        const dateCard = page.locator('.bb-thread-card').filter({ has: page.locator('.bb-thread-name', { hasText: '公园见面约定' }) });
        assert.ok((await dateCard.locator('.bb-thread-last-summary').innerText()).includes('上次总结时间'));
        assert.ok(!(await dateCard.locator('.bb-thread-last-summary').innerText()).includes('尚未总结'));
        assert.ok((await page.locator('.bb-thread-card').filter({ has: page.locator('.bb-thread-name', { hasText: '公园游玩' }) }).locator('.bb-thread-last-summary').innerText()).includes('尚未总结')); await layout(page, width);
        const original = await state(page);
        // Suggestions and edits stay out of storage until explicitly selected and applied.
        await page.locator('#bb_thread_ai_tags').click(); await review(page).waitFor();
        assert.equal(await review(page).locator('.bb-curate-select').count(), 2); assert.equal(await review(page).locator('.bb-curate-select:checked').count(), 0); assert.deepEqual(await state(page), original);
        const tagSelect = await editTag(page, 1, 'timeline-love'); assert.equal(await tagSelect.locator('option').count(), 4); await layout(page, width);
        await page.screenshot({ path: join(output, `tag-review-${width}.png`) }); await closeReview(page); await waitIdle(page); assert.deepEqual(await state(page), original);
        // A saved draft keeps user edits. Applying it updates visible badges immediately.
        await page.locator('#bb_thread_organization_resume').click(); await review(page).waitFor(); await editTag(page, 1, 'timeline-love');
        await review(page).locator('[data-action="save_draft"]').click(); await review(page).waitFor({ state: 'detached' }); await waitIdle(page); assert.deepEqual(await state(page), original);
        await page.locator('#bb_thread_organization_resume').click(); await review(page).waitFor(); assert.equal(await (await editTag(page, 1)).inputValue(), 'timeline-love');
        await selectAll(page); await review(page).locator('[data-action="apply"]').click(); await review(page).waitFor({ state: 'detached' }); await waitIdle(page);
        let after = await state(page);
        assert.equal(after.milestones.find(e => e.event === '讨论到公园见面').timelineId, 'timeline-date'); assert.equal(after.milestones.find(e => e.event === '在公园赏花').timelineId, 'timeline-love');
        assert.ok((await page.locator('.bb-thread-detail-item').filter({ hasText: '讨论到公园见面' }).innerText()).includes('公园见面约定')); assert.ok((await page.locator('.bb-thread-detail-item').filter({ hasText: '在公园赏花' }).innerText()).includes('A 与 B 的感情线'));
        assert.equal(after.timeline.find(e => e.id === 'timeline-date').lastSummarizedAt, 1700000000000);
        await page.locator('#bb_thread_organization_undo').click(); await waitIdle(page); after = await state(page);
        assert.equal(after.milestones.find(e => e.event === '讨论到公园见面').timelineId, ''); assert.equal(after.milestones.find(e => e.event === '在公园赏花').timelineId, 'timeline-walk');
        // Merging preserves events and tags, moves milestone/parent references, and is undoable.
        await page.evaluate(() => { aiMode = 'merge'; }); const beforeMerge = await state(page);
        await page.locator('#bb_thread_ai_merge').click(); await review(page).waitFor(); assert.equal(await review(page).locator('.bb-curate-select').count(), 1); assert.equal(await review(page).locator('.bb-curate-select:checked').count(), 0);
        await review(page).locator('.bb-curate-editor summary').click(); assert.equal(await review(page).getByRole('textbox', { name: /时间线事件/ }).count(), 0); assert.deepEqual(await state(page), beforeMerge); await layout(page, width);
        await page.screenshot({ path: join(output, `merge-review-${width}.png`) }); await closeReview(page); await waitIdle(page); assert.deepEqual(await state(page), beforeMerge);
        await page.locator('#bb_thread_organization_resume').click(); await review(page).waitFor(); await selectAll(page); await review(page).locator('[data-action="apply"]').click(); await review(page).waitFor({ state: 'detached' }); await waitIdle(page);
        after = await state(page); assert.equal(after.timeline.length, 2); const merged = after.timeline.find(e => e.id === 'timeline-date');
        assert.equal(merged.name, 'A 与 B 的公园之行'); assert.deepEqual(merged.entries.map(e => e.event), ['约定一起到公园见面', '一起游玩公园']); assert.deepEqual((merged.tags || []).map(t => typeof t === 'string' ? t : t.name).sort(), ['公园', '约定']); assert.equal(merged.lastSummarizedAt, 1700000000000);
        assert.equal(after.milestones.find(e => e.event === '在公园赏花').timelineId, merged.id); assert.equal(after.timeline.find(e => e.id === 'timeline-love').parentThreadId, merged.id); assert.equal(await page.locator('.bb-thread-card').count(), 2); assert.ok((await page.locator('.bb-thread-detail-item').filter({ hasText: '在公园赏花' }).innerText()).includes(merged.name));
        await page.locator('#bb_thread_organization_undo').click(); await waitIdle(page); after = await state(page);
        assert.equal(after.timeline.length, 3); assert.equal(after.timeline.find(e => e.id === 'timeline-love').parentThreadId, 'timeline-walk'); assert.equal(after.milestones.find(e => e.event === '在公园赏花').timelineId, 'timeline-walk'); assert.equal(await page.locator('.bb-thread-card').count(), 3);
        // Summary acceptance updates the visible management time; undo restores the old time.
        await page.evaluate(() => { aiMode = 'summary'; }); await page.locator('#bb_thread_refresh_inline').click(); await page.locator('.bb-summary-scope').selectOption('all_threads');
        await page.locator('.bb-thread-summary-popup [data-action="generate"]').click(); await review(page).waitFor(); assert.equal(await review(page).locator('.bb-curate-select').count(), 3);
        await selectAll(page); await review(page).locator('[data-action="apply"]').click(); await review(page).waitFor({ state: 'detached' });
        await page.waitForFunction(() => [...document.querySelectorAll('.bb-thread-last-summary')].every(element => !element.textContent.includes('尚未总结'))); after = await state(page);
        assert.ok(after.timeline.every(entry => entry.lastSummarizedAt > 1700000000000));
        const expectedDate = await page.evaluate(async () => { const s = await import('/BB-Memory/memory-store.js'); const d = await import('/BB-Memory/timeline-display.js'); return d.formatTimelineSummaryTime((await s.getTimeline('organization951')).find(t => t.id === 'timeline-date').lastSummarizedAt); });
        assert.ok((await dateCard.locator('.bb-thread-last-summary').innerText()).includes(expectedDate)); await page.screenshot({ path: join(output, `summary-time-${width}.png`) });
        await page.locator('#bb_thread_organization_undo').click(); await waitIdle(page); after = await state(page); assert.equal(after.timeline.find(e => e.id === 'timeline-date').lastSummarizedAt, 1700000000000);
        assert.ok((await page.locator('.bb-thread-card').filter({ has: page.locator('.bb-thread-name', { hasText: '公园游玩' }) }).locator('.bb-thread-last-summary').innerText()).includes('尚未总结'));
        // Maintenance exposes the same working actions and resumes the correct edited draft.
        await page.evaluate(() => { aiMode = 'tags'; }); await page.evaluate(async () => (await import('/BB-Memory/memory-organization.js')).openMemoryOrganization('organization951', { initialTab: 'maintenance' }));
        await page.waitForFunction(() => !document.querySelector('[data-action="summary"]').disabled);
        for (const action of ['timeline_tags', 'timeline_merge', 'resume_timeline_organization']) assert.equal(await page.locator(`[data-panel="maintenance"] [data-action="${action}"]`).isVisible(), true);
        assert.ok((await page.locator('.bb-organization-summary-times').innerText()).includes('上次总结')); assert.ok((await page.locator('.bb-organization-summary-times').innerText()).includes('尚未总结'));
        await page.locator('[data-action="timeline_tags"]').click(); await review(page).waitFor(); await editTag(page, 0, 'timeline-love'); await review(page).locator('[data-action="save_draft"]').click(); await review(page).waitFor({ state: 'detached' });
        await page.waitForFunction(() => !document.querySelector('[data-action="resume_timeline_organization"]').disabled); await page.locator('[data-action="resume_timeline_organization"]').click(); await review(page).waitFor(); assert.equal(await (await editTag(page, 0)).inputValue(), 'timeline-love'); await closeReview(page);
        await page.waitForFunction(() => !document.querySelector('[data-action="timeline_merge"]').disabled); await page.evaluate(() => { aiMode = 'merge'; }); await page.locator('[data-action="timeline_merge"]').click(); await review(page).waitFor(); assert.equal(await review(page).locator('.bb-curate-select').count(), 1); await layout(page, width); await page.screenshot({ path: join(output, `maintenance-${width}.png`) }); await closeReview(page);
        assert.ok(await page.evaluate(() => requests.filter(r => r.mode !== 'summary').every(r => r.source.timeline.length === 3))); assert.deepEqual(errors, []); await page.close();
        console.log(`PASS organization browser ${width}px: timestamps/summary date refresh/undo, tag edit/cancel/draft/apply/undo, merge/tag migration/undo, maintenance entries, layout`);
    }
} catch (error) { if (activePage && !activePage.isClosed()) console.log('TEST FAILURE STATE', await activePage.evaluate(() => ({ status: document.querySelector('.bb-thread-summary-status')?.textContent, toasts: globalThis.toasts, requests: globalThis.requests }))); throw error; } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }






