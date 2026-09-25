import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const bank = new Map();
const lf = { async getItem(k) { return structuredClone(bank.get(k) ?? null); }, async setItem(k, v) { bank.set(k, structuredClone(v)); return v; }, async removeItem(k) { bank.delete(k); } };
const ctx = { libs: { localforage: lf }, extensionSettings: {}, chatId: 'test946', characterId: 0, chat: [], chatMetadata: {}, saveSettingsDebounced() {}, saveMetadataDebounced() {} };
globalThis.SillyTavern = { getContext: () => ctx }; globalThis.window = globalThis;
const store = await import('../memory-store.js');
const core = await import('../memory-agent-core.js');
const maint = await import('../maintenance-actions.js');
const health = await import('../memory-health-check.js');
const state = await import('../maintenance-state.js');
store.updateSettings({ autoBackupEnabled: false, autoGenEndpoint: 'https://mock.invalid', autoGenApiKey: '', embeddingEnabled: true, embeddingEndpoint: 'https://mock.invalid', agentPageSize: 2 });
let responses = [], requests = [], embeddingFailures = false, embeddingHook;
globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.input) {
        await embeddingHook?.(body);
        if (embeddingFailures && body.input.includes('坏向量')) throw new Error('模拟向量服务失败');
        return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
    }
    assert.ok(responses.length, '不应额外调用 API');
    const response = responses.shift();
    return { ok: true, json: async () => ({ choices: [{ message: { content: typeof response === 'function' ? response(body) : response } }] }) };
};
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
const read = obj => 'JSON_READ: ' + JSON.stringify(obj);
const action = obj => 'JSON_ACTION: ' + JSON.stringify(obj);
const npc = await store.addNpcProfile(ctx.chatId, { name: '林澈', aliases: ['阿澈'], role: '医生', indexCard: '林澈是医生', embedding: [0.1, 0.2, 0.3] });
const archived = await store.addMemory(ctx.chatId, { title: '归档证据', content: '林澈在医院工作', archived: true, category: '关闭的分类', hiddenNotes: [{ content: '林澈实际上是老师', allowInjection: false }] });
await store.addRealtimeMemory(ctx.chatId, { text: '阿澈带着历史书', kind: 'object' });
await test('全库搜索含归档/隐藏备注/实时，不写入模型建议', async () => {
    responses = [read({ tool: 'search', query: '林澈' }), body => {
        const result = JSON.parse(body.messages.at(-1).content.split('\n').slice(1).join('\n'))[0].result;
        assert.ok(result.total >= 3); assert.equal(result.nextOffset, 2);
        return read({ tool: 'detail', key: `npc:${npc.id}` }) + '\n' + read({ tool: 'detail', key: `mem:${archived.id}` });
    }, body => {
        assert.ok(body.messages.at(-1).content.includes('实际上是老师'));
        return '职业与原文有冲突，建议更正。\n' + action({ action: 'update_entry', key: `npc:${npc.id}`, patch: { role: '老师', indexCard: '林澈是老师' }, reason: '用户核实职业' });
    }];
    const result = await core.runAgentQuery(ctx.chatId, '林澈的职业可能错了');
    assert.equal(result.proposals.length, 1); assert.equal(result.actions.length, 0);
    assert.equal((await store.getNpcProfiles(ctx.chatId))[0].role, '医生');
});
await test('执行编号直接使用已预览内容，不再请求模型，清理旧向量', async () => {
    const before = requests.length;
    const result = await core.runAgentQuery(ctx.chatId, '执行建议 1');
    assert.equal(requests.length, before); assert.equal(result.actions[0].success, true);
    const entry = (await store.getNpcProfiles(ctx.chatId))[0];
    assert.equal(entry.role, '老师'); assert.equal(entry.indexCard, '林澈是老师'); assert.equal(entry.embeddingRef, null);
    assert.equal(core.getAgentProposals(ctx.chatId).length, 0);
    await assert.rejects(() => core.runAgentQuery(ctx.chatId, '执行建议 1'), /编号不存在/);
});
await test('无原文/伪造ID/危险字段建议均不执行', async () => {
    responses = [action({ action: 'update_entry', key: `npc:${npc.id}`, patch: { role: '作家' } })];
    let result = await core.runAgentQuery(ctx.chatId, '检查职业'); assert.equal(result.proposals.length, 0); assert.match(result.answer, /尚未读取/);
    responses = [read({ tool: 'detail', key: `npc:${npc.id}` }), action({ action: 'update_entry', key: `npc:${npc.id}`, patch: { id: 'hijack' } })];
    result = await core.runAgentQuery(ctx.chatId, '检查字段'); assert.equal(result.proposals.length, 0); assert.match(result.answer, /不支持修改字段/);
    assert.throws(() => core.validateAgentPatch({ entry: {} }, { tags: 'bad' }), /数组/);
    assert.throws(() => core.validateAgentPatch({ entry: {} }, { confidence: 2 }), /数值/);
});
await test('待执行建议遇到并发修改拒绝覆盖，失败保留', async () => {
    responses = [read({ tool: 'detail', key: `npc:${npc.id}` }), action({ action: 'update_entry', key: `npc:${npc.id}`, patch: { role: '历史老师' } })];
    await core.runAgentQuery(ctx.chatId, '建议更正');
    await store.updateNpcProfile(ctx.chatId, npc.id, { role: '用户手改' });
    const result = await core.executeAgentProposals(ctx.chatId, [1]); assert.match(result.actions[0].error, /其它操作/);
    assert.equal(core.getAgentProposals(ctx.chatId).length, 1);
    core.resetAgentSession(ctx.chatId); assert.equal(core.getAgentProposals(ctx.chatId).length, 0);
});
await test('未知执行编号整批拒绝，不串到其他聊天', async () => {
    await assert.rejects(() => core.executeAgentProposals(ctx.chatId, [9]), /编号不存在/);
    await assert.rejects(() => core.runAgentQuery('other', '查询'), /聊天已切换/);
});
await test('上下文限制0生效，多轮读到上限明确告知', async () => {
    store.updateSettings({ agentMaxRounds: 1, agentHistoryMessages: 0 });
    responses = [body => { assert.ok(!JSON.stringify(body).includes('不应携带的旧历史')); return read({ tool: 'list' }); }];
    const result = await core.runAgentQuery(ctx.chatId, '列出条目', [{ role: 'assistant', content: '不应携带的旧历史' }]); assert.match(result.answer, /仍有结果未读完/);
    store.updateSettings({ agentMaxRounds: 8, agentHistoryMessages: 12 });
});
await test('长条目必须分段读完，不能跳过原文', async () => {
    const long = await store.addMemory(ctx.chatId, { title: '长文', content: '原文'.repeat(700) });
    store.updateSettings({ agentDetailChars: 1000 });
    responses = [read({ tool: 'detail', key: `mem:${long.id}`, offset: 1000 }), action({ action: 'update_entry', key: `mem:${long.id}`, patch: { title: '跳读' } })];
    let result = await core.runAgentQuery(ctx.chatId, '检查长文'); assert.equal(result.proposals.length, 0);
    responses = [read({ tool: 'detail', key: `mem:${long.id}` }), read({ tool: 'detail', key: `mem:${long.id}`, offset: 1000 }), action({ action: 'update_entry', key: `mem:${long.id}`, patch: { title: '已完整核查' } })];
    result = await core.runAgentQuery(ctx.chatId, '检查长文'); assert.equal(result.proposals.length, 1); core.resetAgentSession(ctx.chatId);
    store.updateSettings({ agentDetailChars: 12000 });
});
await test('重置提示词协议兼容旧自定义，模型空响应明确失败', async () => {
    store.updateSettings({ customPromptTemplates: { 'agent.systemPrompt': '旧版指令：立即执行 ACTION' } });
    responses = [body => { assert.ok(body.messages[0].content.includes('覆盖旧 ACTION 协议')); return ''; }];
    await assert.rejects(() => core.runAgentQuery(ctx.chatId, '查询'), /空内容/);
    store.updateSettings({ customPromptTemplates: {} });
});

const good = await store.addMemory(ctx.chatId, { title: '正常向量', content: '正常内容' });
const bad = await store.addMemory(ctx.chatId, { title: '坏向量', content: '模拟失败' });
let missing = (await health.runHealthCheck(ctx.chatId)).categories.embedding.issues;
await test('体检缺失向量覆盖NPC，归档不进入活跃维护', async () => {
    assert.ok(missing.some(i => i.collection === 'npc' && i.id === npc.id));
    assert.ok(!missing.some(i => i.id === archived.id));
});
await test('批量忽略持久化、按聊天隔离、修改后重现、可恢复', async () => {
    const targets = missing.filter(i => [good.id, bad.id].includes(i.id));
    const result = await maint.executeMaintenanceBatch(ctx.chatId, targets, 'ignore'); assert.equal(result.succeeded.length, 2);
    assert.ok(ctx.chatMetadata.bb_memory_maintenance_ignored);
    assert.equal((await health.runHealthCheck(ctx.chatId)).categories.embedding.issues.filter(i => [good.id, bad.id].includes(i.id)).length, 0);
    assert.equal((await state.filterIgnoredIssues('other', targets)).length, 2);
    await store.updateMemory(ctx.chatId, good.id, { content: '内容已变化' });
    assert.ok((await health.runHealthCheck(ctx.chatId)).categories.embedding.issues.some(i => i.id === good.id));
    await state.resetIgnoredIssues(ctx.chatId);
    assert.ok((await health.runHealthCheck(ctx.chatId)).categories.embedding.issues.some(i => i.id === bad.id));
});
await test('批量补向量部分失败不影响后项，成功和失败准确计数', async () => {
    missing = (await health.runHealthCheck(ctx.chatId)).categories.embedding.issues;
    const targets = [bad.id, good.id, npc.id].map(id => missing.find(i => i.id === id));
    embeddingFailures = true; const progress = [];
    const result = await maint.executeMaintenanceBatch(ctx.chatId, targets, 're_embed', { onProgress: done => progress.push(done) });
    assert.equal(result.succeeded.length, 2); assert.equal(result.failed.length, 1); assert.deepEqual(progress, [0, 1, 2, 3]);
    const after = (await health.runHealthCheck(ctx.chatId)).categories.embedding.issues;
    assert.ok(after.some(i => i.id === bad.id)); assert.ok(!after.some(i => i.id === good.id || i.id === npc.id));
    embeddingFailures = false;
});
await test('向量请求期间原文变化不能写入过期向量', async () => {
    const issue = (await health.runHealthCheck(ctx.chatId)).categories.embedding.issues.find(i => i.id === bad.id);
    embeddingHook = async () => { await store.updateMemory(ctx.chatId, bad.id, { content: '同时编辑了正文' }); };
    const result = await maint.executeMaintenanceBatch(ctx.chatId, [issue], 're_embed'); assert.match(result.failed[0].error, /生成期间/);
    embeddingHook = null;
});
await test('管家维护调查→待执行→按编号维护复用同一执行器', async () => {
    responses = [read({ tool: 'maintenance', type: 'missing_embedding' }), body => {
        const items = JSON.parse(body.messages.at(-1).content.split('\n').slice(1).join('\n'))[0].result.items;
        return action({ action: 'maintenance', issueKey: items[0].key, op: 'ignore', reason: '用户决定稍后补全' });
    }];
    const result = await core.runAgentQuery(ctx.chatId, '整理缺少向量维护建议'); assert.equal(result.actions.length, 0); assert.equal(result.proposals.length, 1);
    const executed = await core.runAgentQuery(ctx.chatId, '执行全部建议'); assert.equal(executed.actions[0].success, true);
});
await test('停止批量任务不会宣称未完成项成功', async () => {
    const controller = new AbortController(); controller.abort();
    const issue = (await health.runHealthCheck(ctx.chatId)).categories.embedding.issues[0];
    const result = await maint.executeMaintenanceBatch(ctx.chatId, [issue], 'ignore', { signal: controller.signal });
    assert.equal(result.cancelled, true); assert.equal(result.succeeded.length, 0);
});
await test('归档/恢复遵循时间线与实时记忆生命周期', async () => {
    const timeline = await store.upsertTimeline(ctx.chatId, { name: '测试故事线', status: 'ongoing' });
    const realtime = await store.addRealtimeMemory(ctx.chatId, { text: '测试实时细节', kind: 'object' });
    responses = [read({ tool: 'detail', key: `timeline:${timeline.id}` }) + '\n' + read({ tool: 'detail', key: `realtime:${realtime.id}` }),
        action({ action: 'archive_entry', key: `timeline:${timeline.id}` }) + '\n' + action({ action: 'archive_entry', key: `realtime:${realtime.id}` })];
    await core.runAgentQuery(ctx.chatId, '建议归档');
    assert.equal((await core.runAgentQuery(ctx.chatId, '执行全部建议')).actions.filter(a => a.success).length, 2);
    assert.equal((await store.getTimeline(ctx.chatId)).find(e => e.id === timeline.id).status, 'archived');
    assert.equal((await store.getRealtimeMemories(ctx.chatId)).find(e => e.id === realtime.id).settleState, 'settled');
    assert.ok(!(await health.runHealthCheck(ctx.chatId)).categories.embedding.issues.some(i => i.id === timeline.id));
    responses = [read({ tool: 'detail', key: `realtime:${realtime.id}` }), action({ action: 'restore_entry', key: `realtime:${realtime.id}` })];
    await core.runAgentQuery(ctx.chatId, '建议恢复');
    assert.equal((await core.runAgentQuery(ctx.chatId, '执行全部建议')).actions[0].success, true);
    assert.equal((await store.getRealtimeMemories(ctx.chatId)).find(e => e.id === realtime.id).settleState, 'active');
});
await test('永恒条目不降级；向量生成期间取消不会写回', async () => {
    const eternal = await store.addMemory(ctx.chatId, { title: '永恒记录', content: '不可自动维护', memoryTier: 'eternal' });
    const guarded = await maint.executeMaintenanceBatch(ctx.chatId, [{ id: eternal.id, type: 'stale', entry: eternal }], 'demote');
    assert.match(guarded.failed[0].error, /不参与维护/);
    const fresh = await store.addMemory(ctx.chatId, { title: '取消测试', content: '待生成' });
    const controller = new AbortController(); embeddingHook = async () => controller.abort();
    const result = await maint.executeMaintenanceBatch(ctx.chatId, [{ id: fresh.id, type: 'missing_embedding', entry: fresh }], 're_embed', { signal: controller.signal });
    assert.equal(result.succeeded.length, 0); assert.match(result.failed[0].error, /未写入/);
    assert.ok(!(await store.getMemories(ctx.chatId)).find(e => e.id === fresh.id).embeddingRef);
    embeddingHook = null;
});
await test('所有新增参数有默认值、导出键、设置填充和保存绑定', async () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
    for (const [key, id] of [['agentMaxRounds', 'max_rounds'], ['agentPageSize', 'page_size'], ['agentDetailChars', 'detail_chars'], ['agentHistoryMessages', 'history_messages'], ['agentTimeoutSeconds', 'timeout_seconds'], ['agentMaxTokens', 'max_tokens']]) {
        assert.ok(Object.hasOwn(store.DEFAULT_SETTINGS, key)); assert.ok(index.includes(`'${key}'`));
        assert.ok(index.includes(`${key}: ['#bb_agent_${id}'`)); assert.ok(index.includes(`bindInput('#bb_agent_${id}', '${key}'`)); assert.ok(html.includes(`id="bb_agent_${id}"`));
    }
    assert.equal(JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url))).version, '9.4.6');
});
console.log(`v9.4.6: ${checks} regression groups passed (mocked API, no real chat data).`);
