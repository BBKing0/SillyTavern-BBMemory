import assert from 'node:assert/strict';

const ctx = { extensionSettings: {}, libs: {}, saveSettingsDebounced() {} };
globalThis.SillyTavern = { getContext: () => ctx };
const store = await import('../memory-store.js');
const retriever = await import('../retriever.js');
const baseSettings = {
    eternalInjectionMode: 'matched', eternalUnmatchedMode: 'none', eternalMatchThreshold: 0.62,
    maxResults: 3, minScoreThreshold: 0.05, tokenBudget: 10000,
    tokenBudgetMode: 'resident_unlimited', floorRecentWindow: 6, enabledCategories: {},
};
const eternal = (id, patch = {}) => ({
    id, title: `Archive ${id}`, content: `FULL_${id}`, summary: `SUMMARY_${id}`,
    verbatim: `DIALOGUE_${id}`, memoryTier: 'eternal', createdAt: Date.now(), sourceFloor: 2,
    ...patch,
});
const unrelated = Array.from({ length: 55 }, (_, i) => eternal(`unrelated${i}`));
const forged = entries => entries.map(memory => ({ memory, score: 1, level: 'L4', resident: true }));
async function render(entries, queryText = 'needle', overrides = {}) {
    return retriever.buildMemoryInjectionPrompt({
        relevantResults: forged(entries), queryText, chatLength: 3,
        settings: { ...store.getSettings(), ...overrides },
    });
}
function setup(overrides = {}) { store.updateSettings({ ...baseSettings, ...overrides }); }
let checks = 0;
async function test(label, fn) { setup(); await fn(); checks++; console.log(`PASS ${label}`); }

await test('55 条无关永恒不因层级、时效、旧常驻标记或 L4 重新入选', async () => {
    const entries = unrelated.map(memory => ({ ...memory, resident: true, status: 'resident' }));
    assert.deepEqual(retriever.getResidentMemories(entries), []);
    assert.deepEqual(retriever.getRelevantMemories(entries, 'needle'), []);
    assert.deepEqual(retriever.mergeExpandedRelevantResults(entries, 'needle', forged(entries), new Set(), 12, 3), []);
    const result = await render(entries);
    assert.equal(result.stats.memoryCount, 0);
    assert.equal(result.text, '');
    const core = eternal('core', { memoryTier: 'core' });
    assert.deepEqual(retriever.getResidentMemories([...entries, core]), [core]);
    assert.ok((await render([core])).text.includes('FULL_core'));
});

await test('常见代词和提问词不构成永恒正文命中', async () => {
    for (const content of ['我们在旧城击退了叛军。', '我们在港口得知了继承人的血统。']) {
        const memory = eternal('pronoun', { title: '', content, summary: '' });
        assert.equal(retriever.getEternalMemoryInjection(memory, '我们现在吃什么？').matched, false);
        assert.deepEqual(retriever.getRelevantMemories([memory], '我们现在吃什么？'), []);
        assert.equal(retriever.getEternalMemoryInjection(memory, '旧城').matched, content.includes('旧城'));
    }
    assert.equal(retriever.getEternalMemoryInjection(eternal('english', { content: 'We have an ancient crown', title: '', summary: '' }), 'What do we do now?').matched, false);
});

await test('正文、标题、摘要、人物、标签、实体、中文词与向量均可提供真实命中', async () => {
    const patches = [
        { content: 'needle remembered' }, { title: 'needle location' }, { summary: 'needle summary' },
        { subject: 'needle' }, { target: 'needle' }, { tags: [{ name: 'needle' }] },
        { entities: [{ name: 'needle' }] }, { entities: ['needle'] },
    ];
    for (const [i, patch] of patches.entries()) {
        const memory = eternal(`field${i}`, patch);
        const decision = retriever.getEternalMemoryInjection(memory, 'needle');
        assert.equal(decision.matched, true);
        assert.equal(decision.level, 'L3');
        assert.equal(decision.resident, false);
        assert.equal(retriever.getRelevantMemories([memory], 'needle')[0].level, 'L3');
    }
    assert.equal(retriever.getEternalMemoryInjection(eternal('cjk', { content: '王国有雪' }), '王国在哪里').matched, true);
    const vector = eternal('vector', { embedding: [1, 0] });
    assert.equal(retriever.getEternalMemoryInjection(vector, 'needle', [1, 0]).level, 'L3');
    assert.equal(retriever.getEternalMemoryInjection(vector, 'needle', [0, 1]).level, null);
    assert.equal(retriever.getEternalMemoryInjection(vector, 'needle', [1]).level, null);
    setup({ eternalMatchThreshold: 0.9 });
    assert.equal(retriever.getEternalMemoryInjection(vector, 'needle', [0.8, 0.6]).level, null);
    setup({ eternalMatchThreshold: 0.8 });
    assert.equal(retriever.getEternalMemoryInjection(vector, 'needle', [0.8, 0.6]).level, 'L3');
    assert.equal(retriever.getEternalMemoryInjection(vector, '  ', [1, 0]).level, null);
});

await test('未命中摘要受 maxResults 和预算限制，近期来源与人物对话不泄露全文', async () => {
    setup({ eternalUnmatchedMode: 'summary' });
    const candidates = retriever.getRelevantMemories(unrelated, 'needle', { maxResults: 3 });
    assert.equal(candidates.length, 3);
    assert.ok(candidates.every(result => result.level === 'L2' && !result.resident));
    const result = await render(unrelated);
    assert.equal(result.stats.memoryCount, 3);
    assert.ok(result.text.includes('SUMMARY_'));
    assert.ok(!result.text.includes('FULL_'));
    assert.ok(!result.text.includes('DIALOGUE_'));
    assert.equal((await render(unrelated, 'needle', { tokenBudget: 1 })).stats.memoryCount, 0);
    assert.equal((await render(unrelated, 'needle', { tokenBudget: 1, tokenBudgetMode: 'strict_total' })).stats.memoryCount, 0);
    const fallback = await render([eternal('fallback', { summary: '', indexCard: 'INDEX_SHORT' })]);
    assert.ok(fallback.text.includes('INDEX_SHORT'));
    assert.ok(!fallback.text.includes('FULL_fallback'));
});

await test('命中全文优先于高分未命中摘要，并在最终格式化再次守住条数上限', async () => {
    setup({ eternalUnmatchedMode: 'summary', maxResults: 1 });
    const hit = eternal('hit', { title: 'needle' });
    const results = [...forged(unrelated), { memory: hit, score: 0.01, level: 'L2' }];
    const merged = retriever.mergeExpandedRelevantResults([], 'needle', results, new Set(), 12, 1);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].memory.id, 'hit');
    const result = await retriever.buildMemoryInjectionPrompt({ relevantResults: results, queryText: 'needle', settings: store.getSettings() });
    assert.deepEqual(result.stats.memoryIds, ['hit']);
    assert.ok(result.text.includes('FULL_hit'));
    assert.ok(result.text.includes('DIALOGUE_hit'));
    assert.ok(!result.text.includes('SUMMARY_unrelated'));
    assert.equal((await render([hit], 'needle', { tokenBudget: 1 })).stats.memoryCount, 0);
    assert.equal((await render([hit], 'needle', { maxResults: 0 })).stats.memoryCount, 0);
});

await test('全部全文模式超过候选数量但只在 resident_unlimited 下豁免预算', async () => {
    setup({ eternalInjectionMode: 'all', maxResults: 1 });
    assert.equal(retriever.getResidentMemories(unrelated).length, 55);
    const candidates = retriever.getRelevantMemories(unrelated, 'needle', { maxResults: 1 });
    assert.equal(candidates.length, 55);
    assert.ok(candidates.every(result => result.level === 'L3' && result.resident));
    const result = await render(unrelated, 'needle', { tokenBudget: 1 });
    assert.equal(result.stats.memoryCount, 55);
    assert.ok(result.text.includes('FULL_unrelated54'));
    assert.equal((await render(unrelated, 'needle', { tokenBudget: 1, tokenBudgetMode: 'strict_total' })).stats.memoryCount, 0);
});

await test('单条优先级支持始终全文、未命中摘要、仅命中，旧条目默认仅命中', async () => {
    setup({ eternalInjectionMode: 'priority', eternalUnmatchedMode: 'summary' });
    const always = eternal('always', { eternalInjectionPriority: 'always' });
    const summary = eternal('summary', { eternalInjectionPriority: 'summary' });
    const matched = eternal('matched', { eternalInjectionPriority: 'matched' });
    const legacy = eternal('legacy');
    const invalid = eternal('invalid', { eternalInjectionPriority: 'invalid' });
    assert.deepEqual(retriever.getResidentMemories([always, summary, matched, legacy, invalid]), [always]);
    const result = await render([always, summary, matched, legacy, invalid]);
    assert.deepEqual(result.stats.memoryIds, ['always', 'summary']);
    assert.ok(result.text.includes('FULL_always'));
    assert.ok(result.text.includes('SUMMARY_summary'));
    assert.ok(!result.text.includes('FULL_summary'));
    assert.ok(!result.text.includes('DIALOGUE_summary'));
    for (const memory of [summary, matched, legacy, invalid]) {
        assert.equal(retriever.getEternalMemoryInjection({ ...memory, title: 'needle' }, 'needle').level, 'L3');
    }
    assert.deepEqual((await render([always, summary], 'needle', { maxResults: 0, tokenBudget: 1 })).stats.memoryIds, ['always']);
});

await test('空输入不算命中，摘要/全部全文仍遵循显式设置', async () => {
    assert.deepEqual(retriever.getRelevantMemories(unrelated, ''), []);
    assert.equal((await render(unrelated, '')).stats.memoryCount, 0);
    setup({ eternalUnmatchedMode: 'summary', maxResults: 2 });
    assert.equal(retriever.getRelevantMemories(unrelated, null, { maxResults: 2 }).length, 2);
    assert.equal((await render(unrelated, '')).stats.memoryCount, 2);
    setup({ eternalInjectionMode: 'all' });
    assert.equal((await render(unrelated, '')).stats.memoryCount, 55);
});

await test('实体关系链不能把无关永恒强制变命中，归档/删除/关闭分类均过滤', async () => {
    const seed = { id: 'seed', title: 'Alice', content: 'Alice detail', memoryTier: 'stable', relatedMemoryIds: ['child'] };
    const child = eternal('child', { title: 'Bob', content: 'Bob detail' });
    const expanded = retriever.mergeExpandedRelevantResults([seed, child], 'Alice', [], new Set(), 12, 3);
    assert.ok(expanded.some(result => result.memory.id === 'seed'));
    assert.ok(!expanded.some(result => result.memory.id === 'child'));
    setup({ eternalUnmatchedMode: 'summary' });
    const summaryExpanded = retriever.mergeExpandedRelevantResults([seed, child], 'Alice', [], new Set(), 12, 3);
    assert.equal(summaryExpanded.find(result => result.memory.id === 'child').level, 'L2');
    setup({ eternalInjectionMode: 'all', enabledCategories: { on: true } });
    const excluded = [
        eternal('archived', { memoryTier: 'archived' }), eternal('archiveFlag', { archived: true }),
        eternal('archiveStatus', { status: 'archived' }), eternal('deleted', { status: 'deleted' }),
        eternal('off', { category: 'off' }),
    ];
    const included = [eternal('common'), eternal('on', { category: 'on' })];
    assert.deepEqual(retriever.getResidentMemories([...excluded, ...included]).map(memory => memory.id), ['common', 'on']);
    assert.deepEqual((await render([...excluded, ...included])).stats.memoryIds, ['common', 'on']);
    const duplicate = await render([included[0], included[0]]);
    assert.deepEqual(duplicate.stats.memoryIds, ['common']);
});

await test('生成使用传入设置快照，最终统计只记录实际入选层级与命中状态', async () => {
    const snapshot = { ...store.getSettings() };
    setup({ eternalInjectionMode: 'all' });
    assert.deepEqual(retriever.getResidentMemories(unrelated, snapshot), []);
    assert.deepEqual(retriever.getRelevantMemories(unrelated, 'needle', { settings: snapshot }), []);
    assert.deepEqual(retriever.mergeExpandedRelevantResults(unrelated, 'needle', forged(unrelated), new Set(), 12, 3, null, snapshot), []);
    const allSnapshot = { ...store.getSettings() };
    setup();
    assert.equal(retriever.getResidentMemories(unrelated, allSnapshot).length, 55);
    assert.equal(retriever.getRelevantMemories(unrelated, 'needle', { settings: allSnapshot }).length, 55);
    setup({ eternalInjectionMode: 'priority' });
    const entries = [
        eternal('always', { eternalInjectionPriority: 'always' }),
        eternal('hit', { title: 'needle' }),
        eternal('summary', { eternalInjectionPriority: 'summary' }),
        eternal('skip'),
        eternal('core', { memoryTier: 'core' }),
    ];
    const result = await render(entries);
    assert.deepEqual(result.stats.memoryInjections, [
        { id: 'always', level: 'L3', matched: false },
        { id: 'core', level: 'L4', matched: null },
        { id: 'hit', level: 'L3', matched: true },
        { id: 'summary', level: 'L2', matched: false },
    ]);
    const strict = await render(entries, 'needle', { tokenBudget: 1, tokenBudgetMode: 'strict_total' });
    assert.deepEqual(strict.stats.memoryInjections, []);
});

await test('没有按需永恒的普通检索保留原实体展开余量', async () => {
    const ordinary = Array.from({ length: 15 }, (_, i) => ({ memory: eternal(`ordinary${i}`, { memoryTier: 'stable', sourceFloor: -1 }), score: 0.6, level: 'L3' }));
    const merged = retriever.mergeExpandedRelevantResults([], '', ordinary, new Set(), 12, 10);
    assert.equal(merged.length, 13);
    const rendered = await retriever.buildMemoryInjectionPrompt({ relevantResults: ordinary, settings: { ...store.getSettings(), maxResults: 10 } });
    assert.equal(rendered.stats.memoryCount, 14);
    const swapped = [ordinary[1], { ...ordinary[0], score: 0.62 }];
    const reroll = await retriever.buildMemoryInjectionPrompt({ relevantResults: swapped, settings: store.getSettings() });
    assert.deepEqual(reroll.stats.memoryIds, ['ordinary1', 'ordinary0']);
});

await test('日常标签继续摘要优先，仅达到既有向量阈值才全文且永不常驻', async () => {
    setup({ eternalInjectionMode: 'all' });
    const daily = eternal('daily', { tags: [{ name: '日常' }], eternalInjectionPriority: 'always', embedding: [1, 0] });
    assert.equal(retriever.getEternalMemoryInjection(daily, 'needle', [1, 0]), null);
    assert.deepEqual(retriever.getResidentMemories([daily]), []);
    assert.equal(retriever.chooseInjectionLevel(daily, 1, true), 'L2');
    assert.equal(retriever.chooseInjectionLevel(daily, 1, true, 0.96), 'L3');
    const summary = await render([daily]);
    assert.ok(summary.text.includes('SUMMARY_daily'));
    assert.ok(!summary.text.includes('FULL_daily'));
    const full = await retriever.buildMemoryInjectionPrompt({ relevantResults: forged([daily]), queryText: 'needle', queryEmbedding: [1, 0], settings: store.getSettings() });
    assert.ok(full.text.includes('FULL_daily'));
    assert.ok(full.text.includes('DIALOGUE_daily'));
    assert.equal((await render([daily], 'needle', { tokenBudget: 1 })).stats.memoryCount, 0);
});

console.log(`PASS v9.5.2 eternal injection ${checks} groups`);
