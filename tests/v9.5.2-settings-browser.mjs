import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(process.env.BB_PLAYWRIGHT_MODULE || import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '_tmp_v952_screens');
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const settingsHtml = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
const currentVersion = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).version;
function functionSource(name) {
    const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(index)?.index;
    assert.ok(start !== undefined, `Missing actual function ${name}`);
    const end = index.indexOf('\n}', start); assert.ok(end > start, name);
    return index.slice(start, end + 2);
}
function constSource(name) {
    const start = index.indexOf(`const ${name} = `), end = index.indexOf(';\n', start);
    assert.ok(start >= 0 && end > start, name);
    return index.slice(start, end + 1);
}
const controls = [
    ['eternalInjectionMode', 'bb_eternal_injection_mode', 'select', 'priority'],
    ['eternalUnmatchedMode', 'bb_eternal_unmatched_mode', 'select', 'summary'],
    ['eternalMatchThreshold', 'bb_eternal_match_threshold', 'number', 0.74],
    ['realtimeInjectionDepth', 'bb_realtime_injection_depth', 'number', 7],
];
const bindLines = index.split('\n').filter(line => controls.some(([, id]) => line.includes(`('#${id}',`)) && /^\s*bind(?:Checkbox|Input|Select)\(/.test(line)).join('\n');
assert.equal(bindLines.split('\n').length, controls.length);
const feedbackStart = index.indexOf("    for (const selector of ['#bb_eternal_injection_mode', '#bb_eternal_unmatched_mode'])");
const feedbackEnd = index.indexOf('\n    }', feedbackStart) + 6;
assert.ok(feedbackStart >= 0 && feedbackEnd > feedbackStart);
const hookStart = index.indexOf("    document.querySelector('#bb_export_extract_settings_btn')?.addEventListener");
const hookEnd = index.indexOf('\n    // 数字/文本输入', hookStart);
assert.ok(hookStart >= 0 && hookEnd > hookStart);
const settingsSource = [
    ...['SETTINGS_EXPORT_VERSION', 'SETTINGS_EXPORT_KEYS', 'SETTING_CONTROL_BINDINGS'].map(constSource),
    ...['bindCheckbox', 'bindInput', 'bindSelect', 'sanitizeApiProfilesForExport', 'mergeImportedApiProfiles', 'buildSettingsExportPayload', 'normalizeImportedSettingsPayload', 'syncSettingsControls', 'restoreApiSettings'].map(functionSource),
    bindLines, index.slice(feedbackStart, feedbackEnd), index.slice(hookStart, hookEnd),
    'globalThis.settingsHooks = { syncSettingsControls, buildSettingsExportPayload, normalizeImportedSettingsPayload };',
    'syncSettingsControls();',
].join('\n');
const baseHtml = '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/BB-Memory/style.css"><style>*{box-sizing:border-box}body{margin:0;background:#171923;color:#eee;font:16px system-ui}button,input,textarea,select{font:inherit}button{cursor:pointer;color:inherit;background:#303348;border:1px solid #666;padding:.4em}.bb-input{background:#242638;color:#eee;border:1px solid #666}</style><body>';
const server = createServer(async (req, res) => {
    try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname === '/settings' || pathname === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(baseHtml + (pathname === '/settings' ? settingsHtml : '') + '</body></html>'); return;
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
const setup = async page => page.evaluate(async () => {
    const bank = new Map();
    const localforage = {
        async getItem(key) { return structuredClone(bank.get(key) ?? null); },
        async setItem(key, value) { bank.set(key, structuredClone(value)); return value; },
        async removeItem(key) { bank.delete(key); }, async keys() { return [...bank.keys()]; },
    };
    const ctx = { chatId: 'manager952', characterId: 0, chat: [], chatMetadata: {}, extensionSettings: {}, libs: { localforage }, saveSettingsDebounced() {}, saveMetadataDebounced() {} };
    globalThis.SillyTavern = { getContext: () => ctx }; globalThis.toasts = [];
    globalThis.toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(type => [type, message => toasts.push({ type, message })]));
    ctx.toastr = globalThis.toastr;
    globalThis.fetch = async url => { if (url === '/api/users/me') return { ok: true, json: async () => ({ handle: 'ui952', created: 1 }) }; throw new Error('Unexpected network: ' + url); };
    globalThis.store = await import('/BB-Memory/memory-store.js');
    store.updateSettings({ autoBackupEnabled: false, embeddingEnabled: false });
});
const layout = async (page, width, selectors) => {
    const measurements = await page.evaluate(selectors => ({
        document: document.documentElement.scrollWidth,
        elements: selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length).map(element => ({ selector, ...element.getBoundingClientRect().toJSON(), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))),
    }), selectors);
    assert.ok(measurements.document <= width + 1, JSON.stringify(measurements));
    for (const element of measurements.elements) {
        assert.ok(element.x >= -1 && element.right <= width + 1, JSON.stringify(element));
        assert.ok(element.scrollWidth <= element.clientWidth + 1, JSON.stringify(element));
    }
};
const form = page => page.locator('.bb-manager-form-overlay');
const memoryCard = (page, title) => page.locator('#bb_mgr_list .bb-mem-item').filter({ has: page.locator('strong', { hasText: title }) });
const memoryState = (page, title) => page.evaluate(async title => (await store.getMemories('manager952')).find(memory => memory.title === title), title);
const saveForm = async page => { await form(page).locator('.bb-form-save').click(); await form(page).waitFor({ state: 'detached' }); };
let browser, activePage;
try {
    browser = await chromium.launch({ headless: true, ...(process.env.BB_BROWSER_CHANNEL ? { channel: process.env.BB_BROWSER_CHANNEL } : {}) });
    for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 850 } }), errors = [];
        activePage = page; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/settings`); await setup(page);
        await page.evaluate(settingsSource => {
            Object.assign(globalThis, {
                getSettings: store.getSettings, updateSettings: store.updateSettings,
                normalizePromptTemplatePatch: value => value || {}, getPromptTemplateAllowedKeys: () => [],
                syncExtractionTagControls() {}, renderPromptTemplateList() {}, refreshProfileDropdown() {}, refreshEmbeddingProfileDropdown() {}, initAutoGenerator() {}, stopAutoGenerator() {},
                showToast(message, type) { toasts.push({ message, type }); },
                downloadTextFile(name, text) { globalThis.settingsDownload = { name, text }; },
            });
            new Function(settingsSource)();
            document.querySelectorAll('.inline-drawer-content,.bb-settings-section-body').forEach(element => { element.style.display = 'block'; });
        }, settingsSource);
        for (const [key, id, type, value] of controls) {
            const input = page.locator('#' + id); assert.equal(await input.count(), 1);
            assert.equal(await input.inputValue(), String(await page.evaluate(key => store.getSettings()[key], key)));
            if (type === 'select') await input.selectOption(value);
            else { await input.fill(String(value)); await input.press('Tab'); }
            assert.deepEqual(await page.evaluate(key => store.getSettings()[key], key), value);
        }
        assert.ok(await page.evaluate(() => toasts.some(toast => toast.message.includes('永恒记忆注入策略已保存'))));
        await layout(page, width, controls.map(([, id]) => '#' + id));
        await page.locator('#bb_eternal_injection_mode').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `eternal-settings-${width}.png`) });
        await page.locator('#bb_realtime_injection_depth').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `realtime-settings-${width}.png`) });
        for (const mode of ['all', 'matched', 'priority']) { await page.locator('#bb_eternal_injection_mode').selectOption(mode); assert.equal(await page.evaluate(() => store.getSettings().eternalInjectionMode), mode); }
        for (const mode of ['none', 'summary']) { await page.locator('#bb_eternal_unmatched_mode').selectOption(mode); assert.equal(await page.evaluate(() => store.getSettings().eternalUnmatchedMode), mode); }
        for (const [id, key, values] of [['bb_eternal_match_threshold', 'eternalMatchThreshold', [0, 1, 0.74]], ['bb_realtime_injection_depth', 'realtimeInjectionDepth', [1, 100, 7]]]) {
            for (const value of values) { await page.locator('#' + id).fill(String(value)); await page.locator('#' + id).press('Tab'); assert.equal(await page.evaluate(key => store.getSettings()[key], key), value); }
        }
        await page.locator('#bb_export_extract_settings_btn').click();
        const exported = await page.evaluate(() => JSON.parse(settingsDownload.text)); assert.equal(exported.version, currentVersion);
        for (const [key, , , value] of controls) assert.deepEqual(exported.settings[key], value);
        const imported = { type: 'bb-memory-settings', settings: { eternalInjectionMode: 'all', eternalUnmatchedMode: 'none', eternalMatchThreshold: 0.81, realtimeInjectionDepth: 3 } };
        await page.locator('#bb_import_extract_settings_file').setInputFiles({ name: 'v952-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
        await page.waitForFunction(() => toasts.at(-1)?.message.includes('设置导入完成'));
        for (const [key, id] of controls) { assert.deepEqual(await page.evaluate(key => store.getSettings()[key], key), imported.settings[key]); assert.equal(await page.locator('#' + id).inputValue(), String(imported.settings[key])); }
        assert.deepEqual(errors, []);
        console.log(`PASS settings ${width}px: initial fill, change/save, all modes, numeric boundaries, export/import roundtrip, visible feedback, layout`);

        await page.goto(`http://127.0.0.1:${server.address().port}/`); await setup(page);
        await page.evaluate(async () => { store.updateSettings({ eternalInjectionMode: 'priority' }); await (await import('/BB-Memory/memory-manager.js')).openMemoryManager('manager952'); });
        if (width <= 480) await page.locator('#bb_mgr_controls_toggle').click();
        await page.locator('.bb-mem-type-filter[data-type="mem"]').click();
        await page.locator('#bb_mgr_add').click();
        assert.equal(await form(page).locator('.bb-f-eternal-priority-field').isVisible(), false);
        await form(page).locator('.bb-f-title').fill('永恒誓约'); await form(page).locator('.bb-f-content').fill('会一直记得这个约定。');
        await form(page).locator('.bb-f-memoryTier').selectOption('eternal');
        assert.equal(await form(page).locator('.bb-f-eternal-priority-field').isVisible(), true);
        assert.equal(await form(page).locator('.bb-f-eternalInjectionPriority').inputValue(), 'matched');
        assert.deepEqual(await form(page).locator('.bb-f-eternalInjectionPriority option').evaluateAll(options => options.map(option => option.value)), ['always', 'summary', 'matched']);
        await form(page).locator('.bb-f-eternalInjectionPriority').selectOption('always');
        await layout(page, width, ['.bb-mem-form-popup', '.bb-f-eternalInjectionPriority']);
        await form(page).locator('.bb-f-eternalInjectionPriority').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `eternal-create-${width}.png`) });
        await saveForm(page); await memoryCard(page, '永恒誓约').waitFor();
        assert.equal((await memoryState(page, '永恒誓约')).eternalInjectionPriority, 'always');
        assert.equal((await memoryState(page, '永恒誓约')).memoryTier, 'eternal');
        assert.equal(await memoryCard(page, '永恒誓约').locator('.bb-eternal-priority-badge').innerText(), '始终全文');
        assert.ok(await page.evaluate(() => toasts.some(toast => toast.type === 'success' && toast.message === '已添加')));
        await memoryCard(page, '永恒誓约').locator('.bb-mem-edit').click();
        assert.equal(await form(page).locator('.bb-f-eternalInjectionPriority').inputValue(), 'always');
        await form(page).locator('.bb-f-eternalInjectionPriority').selectOption('summary');
        await form(page).locator('.bb-f-memoryTier').selectOption('stable');
        assert.equal(await form(page).locator('.bb-f-eternal-priority-field').isVisible(), false);
        await form(page).locator('.bb-f-memoryTier').selectOption('eternal');
        assert.equal(await form(page).locator('.bb-f-eternalInjectionPriority').inputValue(), 'summary');
        await layout(page, width, ['.bb-mem-form-popup', '.bb-f-eternalInjectionPriority']);
        await page.screenshot({ path: join(output, `eternal-edit-${width}.png`) });
        await saveForm(page);
        assert.equal((await memoryState(page, '永恒誓约')).eternalInjectionPriority, 'summary');
        assert.equal(await memoryCard(page, '永恒誓约').locator('.bb-eternal-priority-badge').innerText(), '命中全文，未命中摘要');
        await memoryCard(page, '永恒誓约').locator('.bb-mem-edit').click();
        assert.equal(await form(page).locator('.bb-f-eternalInjectionPriority').inputValue(), 'summary');
        await form(page).locator('.bb-f-eternalInjectionPriority').selectOption('matched'); await saveForm(page);
        assert.equal((await memoryState(page, '永恒誓约')).eternalInjectionPriority, 'matched');
        assert.equal(await memoryCard(page, '永恒誓约').locator('.bb-eternal-priority-badge').innerText(), '仅命中全文');
        await memoryCard(page, '永恒誓约').locator('.bb-mem-edit').click(); await form(page).locator('.bb-f-memoryTier').selectOption('stable'); await saveForm(page);
        assert.equal((await memoryState(page, '永恒誓约')).memoryTier, 'stable'); assert.equal(await memoryCard(page, '永恒誓约').locator('.bb-eternal-priority-badge').count(), 0);
        await memoryCard(page, '永恒誓约').locator('.bb-mem-edit').click(); await form(page).locator('.bb-f-memoryTier').selectOption('eternal'); await form(page).locator('.bb-f-eternalInjectionPriority').selectOption('summary'); await saveForm(page);
        await page.evaluate(async () => { store.updateSettings({ eternalInjectionMode: 'matched' }); document.querySelector('.bb-mem-overlay').remove(); await (await import('/BB-Memory/memory-manager.js')).openMemoryManager('manager952'); });
        if (width <= 480) await page.locator('#bb_mgr_controls_toggle').click();
        await page.locator('.bb-mem-type-filter[data-type="mem"]').click();
        assert.ok((await memoryCard(page, '永恒誓约').locator('.bb-eternal-priority-badge').innerText()).includes('未启用'));
        await layout(page, width, ['.bb-mem-manager', '#bb_mgr_list', '.bb-mem-item', '.bb-eternal-priority-badge']);
        await page.screenshot({ path: join(output, `eternal-card-${width}.png`) });
        assert.ok(await page.evaluate(() => toasts.some(toast => toast.type === 'success' && toast.message === '已更新')));
        assert.deepEqual(errors, []); await page.close();
        console.log(`PASS manager ${width}px: create/edit/readback for all priorities, tier visibility/preservation, card explanation/disabled badge, success feedback, layout`);
    }
} catch (error) {
    if (activePage && !activePage.isClosed()) { await activePage.screenshot({ path: join(output, 'failure.png') }); console.log('FAILURE STATE', await activePage.evaluate(() => ({ toasts, forms: document.querySelectorAll('.bb-manager-form-overlay').length, text: document.body.innerText.slice(-1500) }))); }
    throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
