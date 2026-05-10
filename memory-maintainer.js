/**
 * memory-maintainer.js —— BB-Memory 的"记忆管家巡检员"
 *
 * v2.5 新增：
 *   - 记忆数量阈值检测
 *   - 多维度问题诊断：弱记忆、重复、过期事实、闲置NPC、可归档物品
 *   - 维护建议弹窗（自动整理 / 手动查看 / 稍后提醒）
 *   - 模糊化（fuzzy）：压缩成更短版本而非直接删除
 *   - 归档（archived）：移出检索范围但保留数据
 *   - 珍藏（pinned）保护：不参与自动压缩/归档
 */

import {
    getSettings,
    updateSettings,
    getMemories,
    addMemory,
    updateMemory,
} from './memory-store.js';
import { resolveMemoryType } from './memory-types.js';
import { callMainApi, callCustomApi } from './auto-generator.js';

// ═══════════════════════════════════════════════════════════
//  维护阈值与配置
// ═══════════════════════════════════════════════════════════

const MAINTENANCE_DEFAULTS = {
    threshold: 50,
    remindIntervalMs: 24 * 60 * 60 * 1000,
    weakStrengthCutoff: 0.25,
    staleAccessDays: 14,
    oldAgeDays: 30,
    duplicateSimilarity: 0.65,
};

// ═══════════════════════════════════════════════════════════
//  记忆状态定义
// ═══════════════════════════════════════════════════════════

export const MEMORY_STATUS = Object.freeze({
    active:   { id: 'active',   label: '活跃',   icon: 'fa-circle-check',   color: '#4caf50' },
    fuzzy:    { id: 'fuzzy',    label: '模糊',   icon: 'fa-cloud',          color: '#ff9800' },
    archived: { id: 'archived', label: '归档',   icon: 'fa-box-archive',    color: '#9e9e9e' },
    pinned:   { id: 'pinned',   label: '珍藏',   icon: 'fa-heart',          color: '#e91e63' },
    deleted:  { id: 'deleted',  label: '已删除', icon: 'fa-trash',          color: '#f44336' },
});

// ═══════════════════════════════════════════════════════════
//  问题诊断
// ═══════════════════════════════════════════════════════════

/**
 * 诊断分类：对记忆列表进行全面体检，返回各类问题及原因。
 * 每个问题项 = { memory, reason, category, severity }
 */
export function diagnoseMemories(memories) {
    const now = Date.now();
    const issues = [];

    for (const m of memories) {
        if (m.pinned || m.status === 'archived' || m.status === 'deleted') continue;

        // 1. 弱记忆：强度低
        if ((m.strength ?? 1.0) < MAINTENANCE_DEFAULTS.weakStrengthCutoff) {
            issues.push({
                memory: m,
                reason: `强度仅 ${((m.strength || 0) * 100).toFixed(0)}%，即将被遗忘`,
                category: 'weak',
                severity: 'warning',
            });
        }

        // 2. 长期未访问
        const lastAccess = m.lastAccessedAt || m.createdAt || 0;
        const staleDays = (now - lastAccess) / (24 * 60 * 60 * 1000);
        if (staleDays > MAINTENANCE_DEFAULTS.staleAccessDays && (m.importance ?? 0.5) < 0.6) {
            issues.push({
                memory: m,
                reason: `已 ${Math.floor(staleDays)} 天未被引用`,
                category: 'stale',
                severity: 'info',
            });
        }

        // 3. 过期事实：truthStatus 为 false/rumor/misleading 且较旧
        if (['false', 'rumor', 'misleading'].includes(m.truthStatus)) {
            const ageDays = (now - (m.createdAt || 0)) / (24 * 60 * 60 * 1000);
            if (ageDays > 7) {
                issues.push({
                    memory: m,
                    reason: `标记为「${m.truthStatus === 'false' ? '错误' : m.truthStatus === 'rumor' ? '传闻' : '误导'}」且已存在 ${Math.floor(ageDays)} 天`,
                    category: 'expired_fact',
                    severity: 'warning',
                });
            }
        }

        // 4. 闲置 NPC：npc 类记忆长期未访问且低重要性
        const cogType = resolveMemoryType(m);
        const isNpc = cogType === 'fact' && (m.categoryPath || '').startsWith('npc.');
        if (isNpc && staleDays > MAINTENANCE_DEFAULTS.oldAgeDays && (m.importance ?? 0.5) < 0.4) {
            issues.push({
                memory: m,
                reason: `路人NPC「${m.subject || m.title || '未知'}」已 ${Math.floor(staleDays)} 天未出场`,
                category: 'idle_npc',
                severity: 'info',
            });
        }

        // 5. 可归档物品：item 类记忆低强度低重要性
        const isItem = cogType === 'fact' && (m.categoryPath || '').startsWith('item.');
        if (isItem && (m.strength ?? 1.0) < 0.4 && (m.importance ?? 0.5) < 0.4) {
            issues.push({
                memory: m,
                reason: `物品「${m.subject || m.title || '未知'}」不再重要，可归档`,
                category: 'archivable_item',
                severity: 'info',
            });
        }
    }

    // 6. 重复检测
    const duplicateGroups = findDuplicateGroups(memories);
    for (const group of duplicateGroups) {
        for (let i = 1; i < group.length; i++) {
            issues.push({
                memory: group[i],
                reason: `与「${(group[0].title || group[0].content.slice(0, 20))}」内容重复`,
                category: 'duplicate',
                severity: 'warning',
                relatedId: group[0].id,
            });
        }
    }

    return issues;
}

/**
 * 按类别汇总诊断结果
 */
export function summarizeIssues(issues) {
    const summary = {
        weak: [],
        stale: [],
        expired_fact: [],
        idle_npc: [],
        archivable_item: [],
        duplicate: [],
    };
    for (const issue of issues) {
        if (summary[issue.category]) summary[issue.category].push(issue);
    }
    return summary;
}

// ═══════════════════════════════════════════════════════════
//  重复检测
// ═══════════════════════════════════════════════════════════

function findDuplicateGroups(memories) {
    const active = memories.filter(m => m.status !== 'archived' && m.status !== 'deleted' && !m.pinned);
    const groups = [];
    const used = new Set();

    for (let i = 0; i < active.length; i++) {
        if (used.has(active[i].id)) continue;
        const group = [active[i]];

        for (let j = i + 1; j < active.length; j++) {
            if (used.has(active[j].id)) continue;
            if (textsAreSimilar(active[i].content, active[j].content)) {
                group.push(active[j]);
                used.add(active[j].id);
            }
        }
        if (group.length > 1) {
            used.add(active[i].id);
            groups.push(group);
        }
    }
    return groups;
}

function textsAreSimilar(a, b) {
    if (!a || !b) return false;
    const ta = a.toLowerCase().trim();
    const tb = b.toLowerCase().trim();

    if (ta.includes(tb) || tb.includes(ta)) return true;

    const setA = new Set(ta.split(/[\s,，。！？!?、；;：:""''（）()\n\r\t]+/).filter(t => t.length >= 2));
    const setB = new Set(tb.split(/[\s,，。！？!?、；;：:""''（）()\n\r\t]+/).filter(t => t.length >= 2));
    if (!setA.size || !setB.size) return false;

    const intersection = [...setA].filter(x => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;
    return union > 0 && (intersection / union) > MAINTENANCE_DEFAULTS.duplicateSimilarity;
}

// ═══════════════════════════════════════════════════════════
//  维护操作：模糊化 / 归档 / 状态切换
// ═══════════════════════════════════════════════════════════

/**
 * 模糊化一条记忆：保留 summary/compressed，清空完整 content，标记 status='fuzzy'。
 * pinned 记忆会被跳过。
 */
export async function fuzzyMemory(chatId, memoryId) {
    const memories = await getMemories(chatId);
    const m = memories.find(e => e.id === memoryId);
    if (!m || m.pinned) return null;

    const compressed = m.summary
        || m.content.slice(0, 60) + (m.content.length > 60 ? '...' : '');

    await updateMemory(chatId, memoryId, {
        compressed: m.content,
        content: compressed,
        summary: compressed,
        status: 'fuzzy',
    });
    return memoryId;
}

/**
 * 归档一条记忆：标记 status='archived'，不从数据库删除。
 * pinned 记忆会被跳过。
 */
export async function archiveMemory(chatId, memoryId) {
    const memories = await getMemories(chatId);
    const m = memories.find(e => e.id === memoryId);
    if (!m || m.pinned) return null;

    await updateMemory(chatId, memoryId, { status: 'archived' });
    return memoryId;
}

/**
 * 恢复归档/模糊记忆为活跃状态
 */
export async function restoreMemory(chatId, memoryId) {
    const memories = await getMemories(chatId);
    const m = memories.find(e => e.id === memoryId);
    if (!m) return null;

    const updates = { status: 'active' };
    if (m.status === 'fuzzy' && m.compressed) {
        updates.content = m.compressed;
        updates.compressed = '';
    }
    await updateMemory(chatId, memoryId, updates);
    return memoryId;
}

/**
 * 批量自动整理：
 * 1. 弱记忆 → 模糊化
 * 2. 重复记忆 → 归档副本
 * 3. 闲置NPC / 可归档物品 → 归档
 * 4. 过期事实 → 归档
 * 跳过 pinned 记忆
 */
export async function autoMaintain(chatId, issues) {
    let processed = 0;

    for (const issue of issues) {
        if (issue.memory.pinned) continue;

        switch (issue.category) {
            case 'weak':
                await fuzzyMemory(chatId, issue.memory.id);
                processed++;
                break;
            case 'duplicate':
            case 'idle_npc':
            case 'archivable_item':
            case 'expired_fact':
                await archiveMemory(chatId, issue.memory.id);
                processed++;
                break;
            case 'stale':
                // 长期未访问但不自动处理，只提示
                break;
        }
    }
    return processed;
}

// ═══════════════════════════════════════════════════════════
//  维护触发检查
// ═══════════════════════════════════════════════════════════

/**
 * 检查是否需要触发维护提醒。
 * 返回 { needed, totalMemories, activeIssues, summary } 或 null。
 */
export async function checkMaintenanceNeeded(chatId) {
    const settings = getSettings();
    const threshold = settings.maintenanceThreshold ?? MAINTENANCE_DEFAULTS.threshold;

    // 检查稍后提醒间隔
    const lastRemind = settings._lastMaintenanceRemind || 0;
    if (Date.now() - lastRemind < MAINTENANCE_DEFAULTS.remindIntervalMs) {
        return null;
    }

    const memories = await getMemories(chatId);
    const activeMemories = memories.filter(m => m.status !== 'archived' && m.status !== 'deleted');

    if (activeMemories.length < threshold) return null;

    const issues = diagnoseMemories(activeMemories);
    if (!issues.length) return null;

    return {
        needed: true,
        totalMemories: activeMemories.length,
        threshold,
        issues,
        summary: summarizeIssues(issues),
    };
}

/**
 * 记录用户选择"稍后提醒"
 */
export function dismissMaintenanceRemind() {
    updateSettings({ _lastMaintenanceRemind: Date.now() });
}

// ═══════════════════════════════════════════════════════════
//  维护弹窗 UI 构建
// ═══════════════════════════════════════════════════════════

const CATEGORY_LABELS = {
    weak:            { icon: 'fa-battery-quarter', label: '弱记忆',     desc: '强度过低，即将被遗忘' },
    duplicate:       { icon: 'fa-clone',           label: '重复记忆',   desc: '内容高度相似' },
    expired_fact:    { icon: 'fa-triangle-exclamation', label: '过期事实', desc: '已标记为错误/传闻/误导' },
    idle_npc:        { icon: 'fa-user-slash',      label: '闲置NPC',    desc: '长期未出场的路人角色' },
    archivable_item: { icon: 'fa-box-open',        label: '可归档物品', desc: '不再重要的物品' },
    stale:           { icon: 'fa-clock',            label: '久未使用',   desc: '长期未被检索引用' },
};

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 构建维护弹窗的 HTML
 */
export function buildMaintenanceHTML(result) {
    const { totalMemories, threshold, summary } = result;

    const categorySections = [];

    for (const [cat, meta] of Object.entries(CATEGORY_LABELS)) {
        const items = summary[cat] || [];
        if (!items.length) continue;

        const itemsHTML = items.slice(0, 8).map(issue => {
            const m = issue.memory;
            const title = m.title || m.content.slice(0, 30);
            return `
                <div class="bb-maint-issue-item" data-id="${m.id}" data-cat="${cat}">
                    <label class="checkbox_label">
                        <input type="checkbox" class="bb-maint-checkbox" data-id="${m.id}" checked />
                        <span class="bb-maint-issue-title">${escapeHtml(title)}</span>
                    </label>
                    <span class="bb-maint-issue-reason">${escapeHtml(issue.reason)}</span>
                </div>`;
        }).join('');

        const moreCount = items.length > 8 ? `<div class="bb-maint-more">... 还有 ${items.length - 8} 条</div>` : '';

        categorySections.push(`
            <div class="bb-maint-category">
                <div class="bb-maint-cat-header">
                    <i class="fa-solid ${meta.icon}"></i>
                    <strong>${meta.label}</strong>
                    <span class="bb-maint-cat-count">${items.length}</span>
                    <small>${meta.desc}</small>
                </div>
                <div class="bb-maint-cat-items">${itemsHTML}${moreCount}</div>
            </div>`);
    }

    const totalIssues = result.issues.length;

    return `
        <div class="bb-maint-panel">
            <div class="bb-maint-header">
                <i class="fa-solid fa-toolbox"></i>
                <div>
                    <strong>记忆维护建议</strong>
                    <p>当前共 ${totalMemories} 条活跃记忆（阈值 ${threshold}），发现 ${totalIssues} 个可优化项</p>
                </div>
                <span class="bb-mem-close bb-maint-close" title="关闭" style="margin-left:auto;">&times;</span>
            </div>

            <div class="bb-maint-body">
                ${categorySections.join('')}
            </div>

            <div class="bb-maint-legend">
                <small>
                    <i class="fa-solid fa-heart" style="color:#e91e63"></i> 珍藏记忆不会被自动处理 ·
                    弱记忆 → 模糊化（压缩保留） ·
                    重复/闲置/过期 → 归档（可恢复）
                </small>
            </div>

            <div class="bb-maint-actions">
                <button class="menu_button bb-maint-btn-auto" title="自动处理所有勾选的问题">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> 自动整理
                </button>
                <button class="menu_button bb-maint-btn-manual" title="打开记忆管理面板手动处理">
                    <i class="fa-solid fa-list-check"></i> 手动查看
                </button>
                <button class="menu_button bb-maint-btn-later" title="24小时内不再提醒">
                    <i class="fa-solid fa-clock"></i> 稍后提醒
                </button>
            </div>
        </div>`;
}

// ═══════════════════════════════════════════════════════════
//  v4.4.0: 每日时间线记忆总结
// ═══════════════════════════════════════════════════════════

/**
 * 按故事时间分组记忆，每组调用 AI 生成阶段总结
 * 分组策略：相邻记忆 storyTimeSort 差值 < 500 → 同组
 * 回退：无 storyTimeSort 则按 createdAt 的天数分组
 */
export async function generateTimelineSummary(chatId, options = {}) {
    const memories = await getMemories(chatId);
    const activeMemories = memories.filter(m =>
        m.status === 'active' && !m.isTimelineSummary
    );

    if (activeMemories.length < 3) {
        return { summaryCount: 0, mergedCount: 0, errors: ['活跃记忆不足（至少需3条）'] };
    }

    const sorted = [...activeMemories].sort((a, b) => {
        const sa = a.storyTimeSort ?? (a.createdAt || 0);
        const sb = b.storyTimeSort ?? (b.createdAt || 0);
        return sa - sb;
    });

    const GAP_THRESHOLD = options.gapThreshold ?? 500;
    const groups = [];
    let currentGroup = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        const prevSort = prev.storyTimeSort ?? (prev.createdAt || 0);
        const currSort = curr.storyTimeSort ?? (curr.createdAt || 0);

        if (currSort - prevSort < GAP_THRESHOLD) {
            currentGroup.push(curr);
        } else {
            groups.push(currentGroup);
            currentGroup = [curr];
        }
    }
    groups.push(currentGroup);

    let summaryCount = 0;
    let mergedCount = 0;
    const errors = [];

    for (const group of groups) {
        if (group.length < 2) continue;
        try {
            const result = await generateGroupSummary(chatId, group, options);
            if (result) {
                if (result.merged) mergedCount++;
                else summaryCount++;
            }
        } catch (e) {
            errors.push(`${group[0]?.storyTime || '?'} ~ ${group[group.length - 1]?.storyTime || '?'}: ${e.message}`);
        }
    }

    return { summaryCount, mergedCount, errors };
}

/**
 * 为一个分组调用 AI 生成时段总结
 */
async function generateGroupSummary(chatId, group, options = {}) {
    const settings = getSettings();

    const memoryTexts = group.map(m =>
        `[${m.storyTime || '未知时间'}] ${m.title || ''}: ${m.summary || m.content.slice(0, 100)}`
    );

    const prompt = `你是一个记忆总结助手。请根据以下时间段内的记忆条目，总结这段时间发生了什么重要事件。

时间段：${group[0]?.storyTime || '开始'} 到 ${group[group.length - 1]?.storyTime || '结束'}

记忆条目：
${memoryTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}

请返回纯JSON对象（不要markdown标记，不要代码块）：
{"n":"时段标题（简短）","c":"本时段总结（2-3句话，概括关键事件和变化）","m":"一句话摘要","i":0.7}`;

    let responseText;
    if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
        responseText = await callCustomApi(prompt);
    } else {
        responseText = await callMainApi(prompt);
    }

    let parsed;
    try {
        let text = responseText.trim();
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const objMatch = text.match(/\{[\s\S]*\}/);
        if (objMatch) text = objMatch[0];
        parsed = JSON.parse(text);
    } catch {
        return null;
    }

    const startTime = group[0]?.storyTime || '';
    const startSort = group[0]?.storyTimeSort ?? null;
    const endSort = group[group.length - 1]?.storyTimeSort ?? null;
    const groupKey = startTime ? `day_${startSort ?? startTime}` : `group_${Date.now()}`;

    // 检查是否已有该组的总结
    const existingSummaries = (await getMemories(chatId)).filter(m =>
        m.isTimelineSummary && m.timelineGroupKey === groupKey
    );
    if (existingSummaries.length > 0) {
        await updateMemory(chatId, existingSummaries[0].id, {
            content: parsed.c || parsed.content || '',
            summary: parsed.m || parsed.summary || '',
            title: parsed.n || parsed.title || '',
            updatedAt: Date.now(),
        });
        return { merged: true };
    }

    await addMemory(chatId,
        parsed.c || parsed.content || memoryTexts.join('\n'),
        'episode',
        'auto',
        {
            cognitiveType: 'episode',
            categoryPath: 'episode.event',
            title: parsed.n || parsed.title || `总结: ${startTime}`,
            summary: parsed.m || parsed.summary || '',
            importance: parsed.i || 0.7,
            emotionalWeight: 0.3,
            isTimelineSummary: true,
            timelineGroupKey: groupKey,
            timelineDayStart: startSort,
            timelineDayEnd: endSort,
            storyTime: startTime,
            storyTimeSort: startSort,
        }
    );
    return { merged: false };
}
