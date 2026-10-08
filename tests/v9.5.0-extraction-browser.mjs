import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(process.env.BB_PLAYWRIGHT_MODULE || import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '_tmp_v950_extraction_screens');
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
                if (url === '/api/users/me') return { ok: true, json: async () => ({ handle: 'extraction950', created: 1 }) };
                throw new Error('Unexpected network: ' + url);
            };
            const bank = new Map();
            const localforage = { async getItem(key) { return structuredClone(bank.get(key) ?? null); }, async setItem(key, value) { bank.set(key, structuredClone(value)); return value; }, async removeItem(key) { bank.delete(key); } };
            const ctx = { libs: { localforage }, extensionSettings: {}, chatId: 'extraction950', characterId: 0, chat: [{ is_user: true, mes: '玩家放下背包并更改远征安排。' }, { is_user: false, mes: '背包被放在空地，新的远征安排确定。', swipe_id: 0 }], chatMetadata: {}, saveSettingsDebounced() {}, saveMetadataDebounced() {} };
            globalThis.SillyTavern = { getContext: () => ctx };
            globalThis.toastr = { success() {}, warning() {}, info() {}, error() {} };
            globalThis.activity = [];
            globalThis.bbMemoryShowToast = (message, type) => activity.push({ message, type });
            const store = await import('/BB-Memory/memory-store.js');
            store.updateSettings({ autoBackupEnabled: false, embeddingEnabled: false, extractionUpdateConfirm: true });
            globalThis.item = await store.addItem(ctx.chatId, { name: '探险背包', owner: '玩家', location: '营地', status: 'held', quantity: 1, significance: '装着远征所需补给' });
            globalThis.memory = await store.addMemory(ctx.chatId, { title: '远征安排', content: '玩家原计划明天出发前往北境，并携带背包和水壶。', summary: '次日远征北境', verbatim: '明天一起走。', subject: '玩家', target: '同伴', storyTime: '王国历123年2月9日', tags: [] });
            globalThis.contextFor = async entriesByPillar => {
                const contexts = await import('/BB-Memory/extraction-context.js');
                contexts.captureInjectionContext(ctx.chatId, ctx.chat[0], entriesByPillar);
                contexts.bindInjectionContextToResponse(ctx.chatId, ctx.chat[1], ctx.chat[0]);
                return contexts.buildExtractionContext(ctx.chatId, { sourceFloor: 1 });
            };
            globalThis.getRecords = async () => ({ item: (await store.getItems(ctx.chatId)).find(entry => entry.id === item.id), memory: (await store.getMemories(ctx.chatId)).find(entry => entry.id === memory.id) });
            await (await import('/BB-Memory/memory-manager.js')).openMemoryManager(ctx.chatId);
        });
        const initial = await page.evaluate(() => getRecords());
        const pending = await page.evaluate(async () => {
            const updates = await import('/BB-Memory/extraction-updates.js');
            const context = await contextFor({ item: [item], mem: [memory] });
            const ops = [
                { op: 'update', pillar: 'item', ids: [item.id], reason: '玩家放下背包，物品目前没有持有者和已知位置', result: { name: item.name, owner: '', location: '', status: 'held', quantity: 1, significance: '装着远征所需补给' } },
                { op: 'update', pillar: 'mem', ids: [memory.id], reason: '玩家已将出发安排改为等待指令，旧原话、对象和时间不再适用', result: { title: memory.title, type: 'event', content: '玩家决定等待新的远征指令，具体出发时间和同行对象尚未确定。', summary: '等待新的远征指令', verbatim: '', subject: '玩家', target: '', storyTime: '', tags: [] } },
            ];
            return updates.processExtractionUpdates('extraction950', ops, context, { onComplete: result => { globalThis.lastReview = result; } });
        });
        assert.equal(pending.pending, 2);
        await page.waitForSelector('#bb_curate_review_overlay');
        assert.deepEqual(await page.evaluate(() => getRecords()), initial);
        for (const checkbox of await page.locator('.bb-curate-select').all()) await checkbox.check();
        await page.locator('.bb-curate-editor summary').first().click();
        const bounds = await page.locator('.bb-active-review-panel').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, JSON.stringify(bounds));
        await page.screenshot({ path: join(output, `optional-empty-confirm-${width}.png`) });
        await page.locator('#bb_curate_review_overlay [data-action="apply"]').click();
        await page.waitForSelector('#bb_curate_review_overlay', { state: 'detached' });
        const updated = await page.evaluate(() => getRecords());
        assert.equal(updated.item.owner, '');
        assert.equal(updated.item.location, '');
        assert.equal(updated.memory.verbatim, '');
        assert.equal(updated.memory.target, '');
        assert.equal(updated.memory.storyTime, '');

        await page.evaluate(async () => {
            const updates = await import('/BB-Memory/extraction-updates.js');
            const records = await getRecords();
            const context = await contextFor({ item: [records.item] });
            await updates.processExtractionUpdates('extraction950', [{ op: 'update', pillar: 'item', ids: [item.id], reason: '同伴拾起背包', result: { name: item.name, owner: '同伴', location: '', status: 'held', significance: '装着远征所需补给' } }], context);
        });
        await page.waitForSelector('#bb_curate_review_overlay');
        await page.locator('#bb_curate_review_overlay .bb-active-review-close').click();
        await page.waitForSelector('#bb_curate_review_overlay', { state: 'detached' });
        assert.equal((await page.evaluate(() => getRecords())).item.owner, '');
        await page.waitForFunction(async () => (await (await import('/BB-Memory/extraction-updates.js')).listPendingExtractionUpdates('extraction950')).length === 1);
        await page.evaluate(() => {
            import('/BB-Memory/extraction-updates.js').then(updates => { globalThis.resumedReview = updates.reviewPendingExtractionUpdates('extraction950'); });
        });
        await page.waitForSelector('#bb_curate_review_overlay');
        assert.ok((await page.locator('#bb_curate_review_overlay').innerText()).includes('同伴拾起背包'));
        for (const checkbox of await page.locator('.bb-curate-select').all()) await checkbox.check();
        await page.screenshot({ path: join(output, `resumed-update-draft-${width}.png`) });
        await page.locator('#bb_curate_review_overlay [data-action="apply"]').click();
        await page.waitForSelector('#bb_curate_review_overlay', { state: 'detached' });
        const resumed = await page.evaluate(() => resumedReview);
        assert.equal(resumed.applied, 1);
        assert.equal((await page.evaluate(() => getRecords())).item.owner, '同伴');
        assert.equal(await page.evaluate(async () => (await (await import('/BB-Memory/extraction-updates.js')).listPendingExtractionUpdates('extraction950')).length), 0);

        const automatic = await page.evaluate(async () => {
            const store = await import('/BB-Memory/memory-store.js');
            const updates = await import('/BB-Memory/extraction-updates.js');
            store.updateSettings({ extractionUpdateConfirm: false });
            const records = await getRecords();
            const context = await contextFor({ mem: [records.memory] });
            const ops = [{ op: 'update', pillar: 'mem', ids: [memory.id], reason: '原远征安排已作废，只保留取消这一事实', result: { title: '远征取消', content: '远征取消。', summary: '远征取消', verbatim: '', subject: '玩家', target: '', storyTime: '' } }];
            const parsed = await updates.parseExtractionUpdates(ops, context);
            const result = await updates.processExtractionUpdates('extraction950', ops, context);
            return { forcedRisk: parsed.ops[0]?.forceConfirm, result, hasModal: Boolean(document.querySelector('#bb_curate_review_overlay')), records: await getRecords() };
        });
        assert.equal(automatic.forcedRisk, true);
        assert.equal(automatic.result.applied, 1);
        assert.equal(automatic.result.pending, 0);
        assert.equal(automatic.hasModal, false);
        assert.equal(automatic.records.memory.content, '远征取消。');
        await page.evaluate(async () => (await import('/BB-Memory/memory-manager.js')).openMemoryManager('extraction950'));
        if (width <= 480) {
            const titleBounds = await page.locator('.bb-mem-item[data-pillar="item"] > div:first-child > strong').boundingBox();
            assert.ok(titleBounds.width >= 100 && titleBounds.height < 40, JSON.stringify(titleBounds));
        }
        await page.screenshot({ path: join(output, `confirmation-disabled-${width}.png`) });
        assert.deepEqual(errors, []);
        await page.close();
    }
    console.log('v9.5.0 extraction browser tests passed at 1280px and 390px');
} finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
}
