/**
 * memory-health-check.js —— BB-Memory 记忆体检模块
 *
 * 检测 7 个维度的数据健康问题，并提供修复操作。
 * 集成到维护面板的第三标签页中。
 */

import {
    getSettings,
    getMemories, getNpcProfiles, getItems, getTimeline,
    addMemory, updateMemory, removeMemory,
    updateNpcProfile, removeNpcProfile,
    updateItem, removeItem,
    updateTimelineEntry, removeTimelineEntry,
    addHiddenNote,
} from './memory-store.js';
import { cyrb53Hash } from './message-state.js';

// ═══════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return Math.max(0, Math.min(1, dot / denom));
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function getContext() {
    try { return SillyTavern.getContext(); } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
//  检测模块
// ═══════════════════════════════════════════════════════════

/**
 * 1. 楼层连续性检测（含重roll检测）
 */
export function detectFloorIssues(chatId, memories, npcs, items, timelines) {
    const ctx = getContext();
    const chat = ctx?.chat || [];
    const issues = [];

    // 收集所有当前存在的 AI 消息及其哈希
    const aiFloorData = {};
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i].is_user && chat[i].mes) {
            aiFloorData[i] = {
                mes: chat[i].mes,
                hash: cyrb53Hash(chat[i].mes),
            };
        }
    }

    const allEntries = [
        ...memories.map(e => ({ ...e, _collection: 'mem' })),
        ...npcs.map(e => ({ ...e, _collection: 'npc' })),
        ...items.map(e => ({ ...e, _collection: 'item' })),
        ...timelines.map(e => ({ ...e, _collection: 'timeline' })),
    ];

    for (const entry of allEntries) {
        if (typeof entry.sourceFloor !== 'number' || entry.sourceFloor < 0) continue;

        const label = entry.title || entry.name || entry.event || entry.id;

        if (entry.sourceFloor >= chat.length || !chat[entry.sourceFloor]) {
            // 楼层已删除
            issues.push({
                id: entry.id,
                collection: entry._collection,
                title: label,
                type: 'floor_deleted',
                detail: `源楼层 #${entry.sourceFloor} 已被删除`,
                severity: 'warning',
                entry,
            });
        } else if (chat[entry.sourceFloor].is_user) {
            // 楼层类型变更
            issues.push({
                id: entry.id,
                collection: entry._collection,
                title: label,
                type: 'floor_type_changed',
                detail: `源楼层 #${entry.sourceFloor} 类型已变更（当前为用户消息）`,
                severity: 'warning',
                entry,
            });
        } else if (entry.sourceMessageHash) {
            // 第二层：消息内容哈希比对（重roll检测）
            const floorData = aiFloorData[entry.sourceFloor];
            if (floorData && floorData.hash !== entry.sourceMessageHash) {
                issues.push({
                    id: entry.id,
                    collection: entry._collection,
                    title: label,
                    type: 'floor_rerolled',
                    detail: `源楼层 #${entry.sourceFloor} 内容已被重roll（哈希不匹配）`,
                    severity: 'warning',
                    entry,
                });
            }
        }
    }

    return issues;
}

/**
 * 2. 语义孤立条目检测
 */
export function detectEmbeddingIsolation(memories, threshold = 0.30) {
    const withEmb = memories.filter(m => Array.isArray(m.embedding) && m.embedding.length > 0);
    if (withEmb.length < 3) return [];

    const issues = [];
    for (let i = 0; i < withEmb.length; i++) {
        let sumSim = 0;
        for (let j = 0; j < withEmb.length; j++) {
            if (i === j) continue;
            sumSim += cosineSimilarity(withEmb[i].embedding, withEmb[j].embedding);
        }
        const avgSim = sumSim / (withEmb.length - 1);
        const isolation = 1 - avgSim;
        if (isolation > threshold) {
            issues.push({
                id: withEmb[i].id,
                title: withEmb[i].title || withEmb[i].id,
                type: 'embedding_isolated',
                isolationScore: isolation,
                avgSimilarity: avgSim,
                detail: `语义孤立度 ${(isolation * 100).toFixed(0)}%（平均相似度 ${(avgSim * 100).toFixed(0)}%）`,
                severity: isolation > 0.7 ? 'warning' : 'info',
                entry: withEmb[i],
            });
        }
    }
    return issues.sort((a, b) => b.isolationScore - a.isolationScore).slice(0, 20);
}

/**
 * 3. 标签孤立条目检测
 */
export function detectTagIsolation(memories) {
    const tagFreq = {};
    for (const m of memories) {
        const tags = (m.tags || []).map(t => typeof t === 'string' ? t : (t?.name || t));
        for (const t of tags) {
            if (t) tagFreq[t] = (tagFreq[t] || 0) + 1;
        }
    }

    const issues = [];
    for (const m of memories) {
        const tags = (m.tags || []).map(t => typeof t === 'string' ? t : (t?.name || t)).filter(Boolean);
        if (tags.length === 0) {
            issues.push({
                id: m.id,
                title: m.title || m.id,
                type: 'untagged',
                detail: '没有任何标签',
                severity: 'info',
                entry: m,
            });
            continue;
        }
        const uniqueToThis = tags.filter(t => (tagFreq[t] || 0) <= 1);
        if (uniqueToThis.length > 0) {
            issues.push({
                id: m.id,
                title: m.title || m.id,
                type: 'tag_isolated',
                uniqueTags: uniqueToThis,
                detail: `孤立标签: ${uniqueToThis.join(', ')}`,
                severity: uniqueToThis.length >= tags.length ? 'warning' : 'info',
                entry: m,
            });
        }
    }
    return issues;
}

/**
 * 4. 近似重复检测
 */
export function detectNearDuplicates(memories, threshold = 0.95) {
    const withEmb = memories.filter(m => Array.isArray(m.embedding) && m.embedding.length > 0);
    if (withEmb.length < 2) return [];

    const pairs = [];
    const maxPairs = 30;

    for (let i = 0; i < withEmb.length; i++) {
        for (let j = i + 1; j < withEmb.length; j++) {
            const sim = cosineSimilarity(withEmb[i].embedding, withEmb[j].embedding);
            if (sim >= threshold) {
                pairs.push({
                    idA: withEmb[i].id,
                    idB: withEmb[j].id,
                    titleA: withEmb[i].title || withEmb[i].id,
                    titleB: withEmb[j].title || withEmb[j].id,
                    similarity: sim,
                    type: 'near_duplicate',
                    detail: `余弦相似度 ${(sim * 100).toFixed(1)}%`,
                    severity: sim > 0.98 ? 'warning' : 'info',
                    entryA: withEmb[i],
                    entryB: withEmb[j],
                });
                if (pairs.length >= maxPairs) break;
            }
        }
        if (pairs.length >= maxPairs) break;
    }

    return pairs.sort((a, b) => b.similarity - a.similarity);
}

/**
 * 5. 缺失向量检测
 */
export function detectMissingEmbeddings(memories, embeddingEnabled) {
    if (!embeddingEnabled) return [];
    return memories
        .filter(m => !m.embedding || !Array.isArray(m.embedding) || m.embedding.length === 0)
        .map(m => ({
            id: m.id,
            title: m.title || m.id,
            type: 'missing_embedding',
            detail: '缺少语义向量（embedding 已启用但此条目无向量）',
            severity: 'info',
            entry: m,
        }));
}

/**
 * 6. 长期休眠检测
 */
export function detectStaleMemories(memories, staleDays = 7, staleHitThreshold = 3) {
    const now = Date.now();
    const staleMs = staleDays * 24 * 60 * 60 * 1000;

    return memories
        .filter(m => {
            if (m.memoryTier === 'eternal') return false;
            const lastHit = m.lastHitAt || m.createdAt;
            const age = now - lastHit;
            return age > staleMs && (m.hitCount || 0) < staleHitThreshold;
        })
        .map(m => {
            const ageDays = Math.floor((now - (m.lastHitAt || m.createdAt)) / (24 * 60 * 60 * 1000));
            return {
                id: m.id,
                title: m.title || m.id,
                type: 'stale',
                detail: `${ageDays} 天未命中，命中 ${m.hitCount || 0} 次`,
                severity: 'info',
                entry: m,
            };
        });
}

/**
 * 7. 来源完整性检测
 */
export function detectSourceIntegrityIssues(chatId, memories, npcs, items, timelines) {
    const ctx = getContext();
    const chat = ctx?.chat || [];

    const chatExchangeHashes = new Set();
    for (const msg of chat) {
        if (msg._bbmem_exchangeHash) {
            chatExchangeHashes.add(msg._bbmem_exchangeHash);
        }
    }

    const allEntries = [
        ...memories.map(e => ({ ...e, _collection: 'mem' })),
        ...npcs.map(e => ({ ...e, _collection: 'npc' })),
        ...items.map(e => ({ ...e, _collection: 'item' })),
        ...timelines.map(e => ({ ...e, _collection: 'timeline' })),
    ];

    const issues = [];
    for (const entry of allEntries) {
        if (!entry.sourceExchange) continue;
        if (!chatExchangeHashes.has(entry.sourceExchange)) {
            issues.push({
                id: entry.id,
                collection: entry._collection,
                title: entry.title || entry.name || entry.event || entry.id,
                type: 'orphaned_exchange',
                detail: '关联的对话轮次 exchange hash 已不在当前聊天中',
                severity: 'info',
                entry,
            });
        }
    }
    return issues;
}

// ═══════════════════════════════════════════════════════════
//  主编排器
// ═══════════════════════════════════════════════════════════

export async function runHealthCheck(chatId) {
    const settings = getSettings();
    const [memories, npcs, items, timelines] = await Promise.all([
        getMemories(chatId),
        getNpcProfiles(chatId),
        getItems(chatId),
        getTimeline(chatId),
    ]);

    const results = {
        checkedAt: Date.now(),
        summary: { totalEntries: 0, totalIssues: 0, healthScore: 100 },
        categories: {},
    };

    // Category 1: Floor continuity (含重roll)
    results.categories.floor = {
        label: '楼层连续性',
        icon: 'fa-solid fa-layer-group',
        issues: detectFloorIssues(chatId, memories, npcs, items, timelines),
    };

    // Category 2: Missing embeddings
    results.categories.embedding = {
        label: '语义向量完整性',
        icon: 'fa-solid fa-vector-square',
        issues: detectMissingEmbeddings(memories, settings.embeddingEnabled),
    };

    // Category 3: Near duplicates (only if embedding enabled)
    results.categories.duplicate = {
        label: '近似重复',
        icon: 'fa-solid fa-copy',
        issues: settings.embeddingEnabled
            ? detectNearDuplicates(memories, settings.healthCheckDuplicateThreshold ?? 0.95)
            : [],
    };

    // Category 4: Embedding isolation
    results.categories.embedIsolation = {
        label: '语义孤立条目',
        icon: 'fa-solid fa-flask',
        issues: settings.embeddingEnabled
            ? detectEmbeddingIsolation(memories, settings.healthCheckIsolationThreshold ?? 0.30)
            : [],
    };

    // Category 5: Tag isolation
    results.categories.tagIsolation = {
        label: '标签孤立条目',
        icon: 'fa-solid fa-tag',
        issues: detectTagIsolation(memories),
    };

    // Category 6: Stale memories
    results.categories.stale = {
        label: '长期休眠记忆',
        icon: 'fa-solid fa-moon',
        issues: detectStaleMemories(
            memories,
            settings.healthCheckStaleDays ?? 7,
            settings.healthCheckStaleHitThreshold ?? 3
        ),
    };

    // Category 7: Source integrity
    results.categories.source = {
        label: '来源完整性',
        icon: 'fa-solid fa-link',
        issues: detectSourceIntegrityIssues(chatId, memories, npcs, items, timelines),
    };

    // Compute summary
    let totalIssues = 0;
    let score = 100;
    const severityPenalty = { warning: 10, info: 3 };
    for (const [, cat] of Object.entries(results.categories)) {
        totalIssues += cat.issues.length;
        for (const issue of cat.issues) {
            score -= severityPenalty[issue.severity] || 3;
        }
    }
    results.summary.totalEntries = memories.length + npcs.length + items.length + timelines.length;
    results.summary.totalIssues = totalIssues;
    results.summary.healthScore = Math.max(0, score);

    return results;
}

// ═══════════════════════════════════════════════════════════
//  UI 构建
// ═══════════════════════════════════════════════════════════

/**
 * 生成问题类型的操作按钮（不包含事件绑定，由调用方绑定）
 */
function getActionButtonsForIssue(issue) {
    const buttons = [];
    const colorMap = {
        keep: '#4caf50',
        promote: '#2196f3',
        demote: '#ff9800',
        delete: '#f44336',
        compress: '#9c27b0',
        aiTag: '#00bcd4',
        manualTag: '#ff9800',
        reEmbed: '#2196f3',
        merge: '#9c27b0',
        clearSource: '#f44336',
        ignore: '#9e9e9e',
    };

    function btn(label, op, color) {
        buttons.push({ label, op, color: color || colorMap[op] || '#9e9e9e' });
    }

    switch (issue.type) {
        case 'floor_deleted':
        case 'floor_type_changed':
        case 'floor_rerolled':
            btn('标记旧楼层', 'fix_floor', '#ff9800');
            btn('忽略', 'ignore');
            break;
        case 'embedding_isolated':
            btn('重新向量化', 're_embed', '#2196f3');
            btn('忽略', 'ignore');
            break;
        case 'tag_isolated':
        case 'untagged':
            btn('AI 建议', 'ai_tag', '#00bcd4');
            btn('手动添加', 'manual_tag', '#ff9800');
            btn('忽略', 'ignore');
            break;
        case 'missing_embedding':
            btn('生成向量', 're_embed', '#2196f3');
            btn('忽略', 'ignore');
            break;
        case 'near_duplicate':
            btn('合并', 'merge', '#9c27b0');
            btn('删除B', 'delete_b', '#f44336');
            btn('忽略', 'ignore');
            break;
        case 'stale':
            btn('刷新命中', 'keep', '#4caf50');
            btn('降级', 'demote', '#ff9800');
            btn('删除', 'delete', '#f44336');
            btn('忽略', 'ignore');
            break;
        case 'orphaned_exchange':
            btn('清除来源', 'clear_source', '#f44336');
            btn('忽略', 'ignore');
            break;
        default:
            btn('忽略', 'ignore');
    }

    return buttons;
}

function createActionButton(label, op, color, handler) {
    const btn = document.createElement('button');
    btn.style.cssText = `padding:2px 8px;border:1px solid ${color};background:transparent;color:${color};border-radius:4px;cursor:pointer;font-size:0.72em;white-space:nowrap;`;
    btn.textContent = label;
    btn.addEventListener('mouseenter', () => { btn.style.background = color + '22'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler(op, btn);
    });
    return btn;
}

/**
 * withFeedback 包装器 —— 操作按钮的 spinner + toast 反馈
 */
function withFeedback(btn, fn, opts = {}) {
    return async () => {
        const orig = btn.textContent;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        try {
            await fn();
            btn.innerHTML = '<i class="fa-solid fa-check"></i>';
            if (opts.successText && typeof toastr !== 'undefined') {
                toastr.success(opts.successText);
            }
        } catch (e) {
            btn.innerHTML = '<i class="fa-solid fa-times"></i>';
            if (typeof toastr !== 'undefined') {
                toastr.error(opts.errorText || e.message);
            }
            console.warn('[BB-HealthCheck] 操作失败:', e);
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
        }
    };
}

/**
 * 构建完整的体检面板 DOM
 */
export function buildHealthCheckPanel(chatId, result, callbacks) {
    const container = document.createElement('div');
    container.style.cssText = 'padding:0;';

    // --- Health Score Banner ---
    const score = result.summary.healthScore;
    const scoreColor = score >= 80 ? '#4caf50' : (score >= 50 ? '#ff9800' : '#f44336');
    const scoreLabel = score >= 80 ? '良好' : (score >= 50 ? '一般' : '需关注');

    const banner = document.createElement('div');
    banner.style.cssText = `display:flex;align-items:center;gap:16px;padding:12px 16px;border-radius:8px;margin-bottom:10px;background:${scoreColor}11;border:1px solid ${scoreColor}33;`;
    banner.innerHTML = `
        <div style="text-align:center;min-width:72px;">
            <div style="font-size:2em;font-weight:bold;color:${scoreColor};">${score}</div>
            <div style="font-size:0.7em;opacity:0.6;">健康分</div>
        </div>
        <div style="flex:1;">
            <div style="font-weight:bold;font-size:0.95em;color:${scoreColor};">${scoreLabel}</div>
            <div style="font-size:0.78em;opacity:0.65;margin-top:2px;">
                ${result.summary.totalEntries} 条条目，${result.summary.totalIssues} 个问题
            </div>
        </div>
        <button class="bb-health-rerun-btn menu_button" style="font-size:0.78em;white-space:nowrap;">
            <i class="fa-solid fa-rotate"></i> 重新体检
        </button>
    `;
    container.appendChild(banner);

    // Re-run button
    banner.querySelector('.bb-health-rerun-btn').addEventListener('click', () => {
        if (callbacks.onRefresh) callbacks.onRefresh();
    });

    // --- Categories ---
    const categoriesWithIssues = Object.entries(result.categories)
        .filter(([, cat]) => cat.issues.length > 0);

    if (categoriesWithIssues.length === 0) {
        const okMsg = document.createElement('div');
        okMsg.style.cssText = 'text-align:center;padding:30px;opacity:0.7;';
        okMsg.innerHTML = '<i class="fa-solid fa-circle-check" style="font-size:2em;color:#4caf50;display:block;margin-bottom:8px;"></i>所有检查通过，记忆状态健康';
        container.appendChild(okMsg);
        return container;
    }

    for (const [catKey, cat] of categoriesWithIssues) {
        const section = buildCategorySection(catKey, cat, chatId, callbacks);
        container.appendChild(section);
    }

    return container;
}

function buildCategorySection(catKey, cat, chatId, callbacks) {
    const section = document.createElement('div');
    section.style.cssText = 'margin-bottom:10px;';

    // Section header
    const header = document.createElement('div');
    header.className = 'bb-maint-cat-header';
    header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;cursor:pointer;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);';
    const hasWarning = cat.issues.some(i => i.severity === 'warning');
    header.innerHTML = `
        <i class="${cat.icon}" style="color:${hasWarning ? '#ff9800' : '#2196f3'};width:16px;"></i>
        <span style="flex:1;font-size:0.9em;font-weight:500;">${cat.label}</span>
        <span class="bb-maint-cat-count">${cat.issues.length}条</span>
        <i class="fa-solid fa-chevron-down" style="font-size:0.7em;opacity:0.5;transition:transform 0.2s;"></i>
    `;

    // Items container
    const itemsDiv = document.createElement('div');
    itemsDiv.className = 'bb-health-items';
    itemsDiv.style.cssText = 'padding-left:2px;';

    for (const issue of cat.issues) {
        const item = buildIssueRow(issue, chatId, callbacks);
        itemsDiv.appendChild(item);
    }

    // Collapse toggle
    header.addEventListener('click', () => {
        const hidden = itemsDiv.style.display === 'none';
        itemsDiv.style.display = hidden ? '' : 'none';
        const chevron = header.querySelector('.fa-chevron-down');
        if (chevron) chevron.style.transform = hidden ? '' : 'rotate(-90deg)';
    });

    section.appendChild(header);
    section.appendChild(itemsDiv);
    return section;
}

function buildIssueRow(issue, chatId, callbacks) {
    const item = document.createElement('div');
    item.className = 'bb-health-item';
    item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,0.05));';

    const severityColor = issue.severity === 'warning' ? '#ff9800' : '#2196f3';

    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;gap:2px;';
    infoDiv.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:0.82em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;" title="${escapeHtml(issue.title || issue.id)}">${escapeHtml(issue.title || issue.id)}</span>
            <span style="font-size:0.65em;color:${severityColor};font-weight:bold;white-space:nowrap;">[${issue.severity === 'warning' ? '⚠ 警告' : 'ℹ 提示'}]</span>
        </div>
        <span style="font-size:0.72em;opacity:0.5;">${escapeHtml(issue.detail)}</span>
    `;

    const actionDiv = document.createElement('div');
    actionDiv.style.cssText = 'display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;';

    const buttons = getActionButtonsForIssue(issue);
    for (const btnDef of buttons) {
        const btn = createActionButton(btnDef.label, btnDef.op, btnDef.color, async (op) => {
            await handleHealthAction(op, issue, chatId, callbacks, item);
        });
        actionDiv.appendChild(btn);
    }

    item.appendChild(infoDiv);
    item.appendChild(actionDiv);
    return item;
}

// ═══════════════════════════════════════════════════════════
//  操作处理器
// ═══════════════════════════════════════════════════════════

async function handleHealthAction(op, issue, chatId, callbacks, rowEl) {
    const itemEl = rowEl;

    switch (op) {
        case 'fix_floor': {
            const { id, collection } = issue;
            await updateEntry(chatId, collection, id, { sourceFloor: -1, sourceMessageHash: '' });
            itemEl.remove();
            notifyCallbacks(callbacks, '已标记为旧楼层');
            break;
        }
        case 'ignore': {
            itemEl.remove();
            break;
        }
        case 're_embed': {
            try {
                const { callEmbeddingApi } = await import('./auto-generator.js');
                const mem = issue.entry;
                const text = (mem.summary || mem.content || '').slice(0, 200);
                if (text) {
                    const embedding = await callEmbeddingApi(text);
                    if (embedding && Array.isArray(embedding) && embedding.length > 0) {
                        await updateMemory(chatId, issue.id, { embedding });
                        itemEl.remove();
                        notifyCallbacks(callbacks, `已生成向量: ${(issue.title || issue.id).slice(0, 30)}`);
                    } else {
                        if (typeof toastr !== 'undefined') toastr.warning('向量生成失败，请检查 Embedding API 设置');
                    }
                }
            } catch (e) {
                console.warn('[BB-HealthCheck] 向量生成失败:', e);
                if (typeof toastr !== 'undefined') toastr.error('向量生成失败: ' + e.message);
            }
            break;
        }
        case 'ai_tag': {
            await handleAiTag(issue, chatId, itemEl, callbacks);
            break;
        }
        case 'manual_tag': {
            await handleManualTag(issue, chatId, itemEl, callbacks);
            break;
        }
        case 'merge': {
            const { idA, idB } = issue;
            try {
                // 附加 B 内容到 A
                const contentB = issue.entryB.content || issue.entryB.summary || '';
                if (contentB) {
                    await addHiddenNote(chatId, idA, {
                        type: 'note',
                        content: `[合并自「${issue.titleB || idB}」]\n${contentB}`,
                        allowInjection: false,
                    });
                }
                await removeMemory(chatId, idB);
                itemEl.remove();
                notifyCallbacks(callbacks, `已合并: ${(issue.titleA || idA).slice(0, 20)} ← ${(issue.titleB || idB).slice(0, 20)}`);
            } catch (e) {
                if (typeof toastr !== 'undefined') toastr.error('合并失败: ' + e.message);
            }
            break;
        }
        case 'delete_b': {
            try {
                await removeMemory(chatId, issue.idB);
                itemEl.remove();
                notifyCallbacks(callbacks, `已删除: ${(issue.titleB || issue.idB).slice(0, 30)}`);
            } catch (e) {
                if (typeof toastr !== 'undefined') toastr.error('删除失败: ' + e.message);
            }
            break;
        }
        case 'keep': {
            const { id, collection } = issue;
            await updateEntry(chatId, collection || 'mem', id, { lastHitAt: Date.now(), hitCount: (issue.entry.hitCount || 0) + 1 });
            itemEl.remove();
            notifyCallbacks(callbacks, '已刷新命中');
            break;
        }
        case 'demote': {
            const { id, collection } = issue;
            await updateEntry(chatId, collection || 'mem', id, { memoryTier: 'transient' });
            itemEl.remove();
            notifyCallbacks(callbacks, '已降级为 transient');
            break;
        }
        case 'delete': {
            const { id, collection } = issue;
            await removeEntry(chatId, collection || 'mem', id);
            itemEl.remove();
            notifyCallbacks(callbacks, `已删除: ${(issue.title || id).slice(0, 30)}`);
            break;
        }
        case 'clear_source': {
            const { id, collection } = issue;
            await updateEntry(chatId, collection, id, { sourceExchange: '', sourceFloor: -1, sourceMessageHash: '' });
            itemEl.remove();
            notifyCallbacks(callbacks, '已清除来源信息');
            break;
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  AI 标签建议 & 手动标签
// ═══════════════════════════════════════════════════════════

async function handleAiTag(issue, chatId, itemEl, callbacks) {
    try {
        const { callMainApi } = await import('./auto-generator.js');
        const mem = issue.entry;
        const content = mem.content || mem.summary || mem.title || '';
        const existingTags = (mem.tags || []).map(t => typeof t === 'string' ? t : t.name).join(', ');

        const prompt = `请为以下角色扮演记忆生成3-5个简洁的标签关键词（每个词不超过6个字），用逗号分隔，只输出标签不要其他内容。\n\n记忆标题：${mem.title || '无标题'}\n记忆内容：${content.slice(0, 500)}\n现有标签：${existingTags || '无'}`;

        const response = await callMainApi(prompt, { maxTokens: 80, temperature: 0.3 });
        const suggestedTags = (response || '').split(/[,，、\n]/).map(t => t.trim()).filter(t => t.length >= 1 && t.length <= 10).slice(0, 6);

        if (suggestedTags.length === 0) {
            if (typeof toastr !== 'undefined') toastr.info('AI 未能生成有效标签');
            return;
        }

        // 弹出确认框让用户选择保留哪些
        showTagConfirmDialog(suggestedTags, issue, chatId, itemEl, callbacks);
    } catch (e) {
        console.warn('[BB-HealthCheck] AI标签建议失败:', e);
        if (typeof toastr !== 'undefined') toastr.error('AI标签建议失败: ' + e.message);
    }
}

function showTagConfirmDialog(suggestedTags, issue, chatId, itemEl, callbacks) {
    // 移除已有弹窗
    document.querySelector('.bb-tag-confirm-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'bb-tag-confirm-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--SmartThemeBlurTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:10px;padding:16px 20px;width:min(360px,90vw);max-height:70vh;overflow-y:auto;';

    dialog.innerHTML = `
        <div style="font-size:0.95em;font-weight:bold;margin-bottom:8px;">AI 建议标签</div>
        <div style="font-size:0.78em;opacity:0.6;margin-bottom:12px;">为「${escapeHtml((issue.title || issue.id).slice(0, 30))}」选择保留的标签</div>
        <div id="bb-tag-options" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="bb-tag-cancel" class="menu_button" style="opacity:0.6;">取消</button>
            <button id="bb-tag-ok" class="menu_button">确认添加</button>
        </div>
    `;

    const optionsDiv = dialog.querySelector('#bb-tag-options');
    const selectedTags = new Set();

    for (const tag of suggestedTags) {
        const chip = document.createElement('span');
        chip.textContent = tag;
        chip.style.cssText = 'padding:4px 10px;border-radius:14px;font-size:0.8em;cursor:pointer;border:1px solid #555;opacity:0.6;user-select:none;';
        chip.addEventListener('click', () => {
            if (selectedTags.has(tag)) {
                selectedTags.delete(tag);
                chip.style.cssText = 'padding:4px 10px;border-radius:14px;font-size:0.8em;cursor:pointer;border:1px solid #555;opacity:0.6;user-select:none;';
            } else {
                selectedTags.add(tag);
                chip.style.cssText = 'padding:4px 10px;border-radius:14px;font-size:0.8em;cursor:pointer;border:1px solid #00bcd4;background:#00bcd422;opacity:1;user-select:none;';
            }
        });
        optionsDiv.appendChild(chip);
    }

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    dialog.querySelector('#bb-tag-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    dialog.querySelector('#bb-tag-ok').addEventListener('click', async () => {
        close();
        if (selectedTags.size === 0) return;
        const mem = issue.entry;
        const existing = new Set((mem.tags || []).map(t => typeof t === 'string' ? t : t.name));
        const newTags = [...selectedTags].filter(t => !existing.has(t));
        if (newTags.length > 0) {
            const allTags = [...(mem.tags || []), ...newTags.map(t => ({ name: t, weight: 0.6 }))];
            await updateMemory(chatId, issue.id, { tags: allTags });
            itemEl.remove();
            notifyCallbacks(callbacks, `已添加标签: ${newTags.join(', ')}`);
        }
    });
}

async function handleManualTag(issue, chatId, itemEl, callbacks) {
    const input = prompt('请输入要添加的标签（逗号分隔）：');
    if (!input || !input.trim()) return;

    const newTags = input.split(/[,，、\s]+/).map(t => t.trim()).filter(t => t.length > 0);
    if (newTags.length === 0) return;

    const mem = issue.entry;
    const existing = new Set((mem.tags || []).map(t => typeof t === 'string' ? t : t.name));
    const toAdd = newTags.filter(t => !existing.has(t));
    if (toAdd.length > 0) {
        const allTags = [...(mem.tags || []), ...toAdd.map(t => ({ name: t, weight: 0.6 }))];
        await updateMemory(chatId, issue.id, { tags: allTags });
        itemEl.remove();
        notifyCallbacks(callbacks, `已添加标签: ${toAdd.join(', ')}`);
    }
}

// ═══════════════════════════════════════════════════════════
//  存储辅助
// ═══════════════════════════════════════════════════════════

async function updateEntry(chatId, collection, id, patch) {
    switch (collection) {
        case 'mem': return updateMemory(chatId, id, patch);
        case 'npc': return updateNpcProfile(chatId, id, patch);
        case 'item': return updateItem(chatId, id, patch);
        case 'timeline': return updateTimelineEntry(chatId, id, patch);
    }
}

async function removeEntry(chatId, collection, id) {
    switch (collection) {
        case 'mem': return removeMemory(chatId, id);
        case 'npc': return removeNpcProfile(chatId, id);
        case 'item': return removeItem(chatId, id);
        case 'timeline': return removeTimelineEntry(chatId, id);
    }
}

function notifyCallbacks(callbacks, msg) {
    if (typeof toastr !== 'undefined') toastr.success(msg);
    if (callbacks?.onAction) callbacks.onAction();
}
