/**
 * memory-cluster.js —— BB-Memory 的"世界线编织者"
 *
 * v4.1.0 新增：标签聚类压缩
 *   当某个标签关联的记忆超过阈值时，AI 生成一条合集摘要记忆，
 *   将子记忆标记为 fuzzy（压缩态），把 token 预算释放给其他主题。
 *
 * 核心操作：
 *   1. checkAndClusterByTags() —— 扫描所有 tag，触发聚类
 *   2. createClusterSummary() —— 调用 AI 生成合集
 *   3. updateClusterSummary() —— 更新已有合集
 */

import { getSettings, getMemories, addMemory, updateMemory, saveMemoriesData } from './memory-store.js';
import { callMainApi, callCustomApi, callEmbeddingApi, parseAiResponse } from './auto-generator.js';

// ═══ 聚类提示词 ═══

function buildClusterPrompt(childMemories, tagName) {
    const lines = [];
    lines.push('你是一个记忆整合助手。以下记忆都与主题「' + tagName + '」相关，请综合成一条合集记忆。');
    lines.push('');
    lines.push('规则：');
    lines.push('1. content 应覆盖子记忆的关键信息，按时间/逻辑顺序组织');
    lines.push('2. summary 为一句话总结（15-25字）');
    lines.push('3. importance 取子记忆的平均重要度（不低于 0.6）');
    lines.push('4. 保持客观，不要编造子记忆中不存在的信息');
    lines.push('5. 使用短码 JSON 格式返回单条记忆');
    lines.push('');
    lines.push('子记忆列表：');
    for (let i = 0; i < childMemories.length; i++) {
        const m = childMemories[i];
        const title = m.title || '(无标题)';
        const summary = m.summary || m.content?.slice(0, 80) || '';
        lines.push(String(i + 1) + ". [" + (title) + "] " + (summary));
    }
    lines.push('');
    lines.push('短码对照：t=cognitiveType p=categoryPath n=title c=content m=summary v=verbatim g=tags s=subject a=target i=importance e=emotionalWeight');
    lines.push('返回示例：{"t":"episode","p":"episode.event","n":"合集标题","c":"综合内容...","m":"一句话摘要","g":["' + tagName + '"],"s":"","a":"","i":0.75,"e":0.5}');
    lines.push('');
    lines.push('只返回一条 JSON 对象（不要数组，不要 markdown 代码块）：');

    return lines.join('\n');
}

/**
 * v4.1.0: 创建一条标签聚类合集
 */
async function createClusterSummary(chatId, tagName, childMemories) {
    const settings = getSettings();
    const prompt = buildClusterPrompt(childMemories, tagName);

    let responseText;
    if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
        responseText = await callCustomApi(prompt);
    } else {
        responseText = await callMainApi(prompt);
    }

    // 解析 AI 返回的单条记忆
    const parsed = parseAiResponse(responseText);
    if (!parsed.length) {
        console.warn("[BB-Memory] 聚类「" + (tagName) + "」失败：AI 未返回有效记忆");
        return null;
    }

    const mem = parsed[0];
    // 生成 embedding
    const embedding = await callEmbeddingApi(mem.summary || mem.content?.slice(0, 100) || tagName)
        .catch(() => null);

    const childIds = childMemories.map(m => m.id);
    const avgImportance = childMemories.reduce((s, m) => s + (m.importance || 0.5), 0) / childMemories.length;

    const entry = await addMemory(chatId, mem.content || '', mem.cognitiveType || 'episode', 'auto', {
        categoryPath: mem.categoryPath || 'episode.event',
        title: mem.title || "「" + (tagName) + "」合集",
        summary: mem.summary || "关于「" + (tagName) + "」的 " + (childMemories.length) + " 条记忆合集",
        verbatim: mem.verbatim || '',
        tags: [{ name: tagName, weight: 1.0 }],
        importance: Math.max(0.6, avgImportance),
        emotionalWeight: mem.emotionalWeight || 0.5,
        subject: mem.subject || '',
        target: mem.target || '',
        isClusterSummary: true,
        clusterTag: tagName,
        clusterChildIds: childIds,
        embedding,
        standaloneArchive: false,
    });

    // 标记子记忆为 fuzzy
    for (const child of childMemories) {
        await updateMemory(chatId, child.id, {
            status: 'fuzzy',
            clusterParentId: entry.id,
        });
    }

    console.log("[BB-Memory] 标签聚类完成: 「" + (tagName) + "」" + (childIds.length) + " 条 → 合集 #" + (entry.id));
    return entry;
}

/**
 * v4.1.0: 更新已有聚类合集（新增子记忆后）
 */
async function updateClusterSummary(chatId, clusterMem, newChildren) {
    const allChildrenIds = [...new Set([
        ...(clusterMem.clusterChildIds || []),
        ...newChildren.map(m => m.id),
    ])];

    // 重新生成合集内容（加上新增的子记忆）
    const tagName = clusterMem.clusterTag || '';
    const settings = getSettings();
    const prompt = buildClusterPrompt(
        newChildren,  // AI 只需看新增的，旧内容通过 clusterMem.content 保留
        tagName
    );

    // 简化：直接在旧 content 后追加新摘要
    const newSummary = newChildren.map(m => m.summary).filter(Boolean).join('；');
    const updatedContent = clusterMem.content + '\n[补充] ' + newSummary;

    await updateMemory(chatId, clusterMem.id, {
        content: updatedContent,
        clusterChildIds: allChildrenIds,
        updatedAt: Date.now(),
    });

    // 标记新子记忆为 fuzzy
    for (const child of newChildren) {
        await updateMemory(chatId, child.id, {
            status: 'fuzzy',
            clusterParentId: clusterMem.id,
        });
    }

    console.log("[BB-Memory] 更新聚类合集「" + (tagName) + "」: +" + (newChildren.length) + " 条子记忆");
}

/**
 * v4.1.0: 扫描所有标签，对超过阈值的标签触发聚类
 * @param {string} chatId
 * @param {Function} [onProgress] - (current, total, tagName) => void
 * @returns {{ clustered: number, updated: number, summary: string }}
 */
export async function checkAndClusterByTags(chatId, onProgress) {
    const settings = getSettings();
    if (!settings.clusterEnabled) return { clustered: 0, updated: 0, summary: '聚类功能未启用' };

    const threshold = settings.clusterTagThreshold || 8;
    const memories = await getMemories(chatId);

    // 找出已有合集（避免重复聚类）
    const existingClusters = new Map();
    for (const m of memories) {
        if (m.isClusterSummary && m.clusterTag) {
            existingClusters.set(m.clusterTag, m);
        }
    }

    // 按 tag.name 统计活跃记忆数
    const tagCounts = new Map();
    for (const m of memories) {
        if (m.status !== 'active') continue;
        if (m.isClusterSummary) continue; // 合集自身不参与统计
        for (const t of (m.tags || [])) {
            const name = typeof t === 'string' ? t : t.name;
            if (!name) continue;
            if (!tagCounts.has(name)) tagCounts.set(name, []);
            tagCounts.get(name).push(m);
        }
    }

    // 筛选超过阈值的标签
    const triggers = [];
    for (const [tagName, mems] of tagCounts) {
        if (mems.length >= threshold) {
            triggers.push({ tagName, count: mems.length, memories: mems });
        }
    }

    if (!triggers.length) {
        return { clustered: 0, updated: 0, summary: "没有标签达到阈值 (≥" + (threshold) + ")" };
    }

    let clustered = 0;
    let updated = 0;
    let progress = 0;

    for (const { tagName, memories: clusterMems } of triggers) {
        const existing = existingClusters.get(tagName);
        if (existing) {
            // 已有合集：找出新增的子记忆
            const existingIds = new Set(existing.clusterChildIds || []);
            const newChildren = clusterMems.filter(m => !existingIds.has(m.id));
            if (newChildren.length > 0) {
                await updateClusterSummary(chatId, existing, newChildren);
                updated++;
            }
        } else {
            await createClusterSummary(chatId, tagName, clusterMems);
            clustered++;
        }
        progress++;
        if (typeof onProgress === 'function') {
            onProgress(progress, triggers.length, tagName);
        }
    }

    const parts = [];
    if (clustered > 0) parts.push("新建 " + (clustered) + " 个合集");
    if (updated > 0) parts.push("更新 " + (updated) + " 个合集");
    const summary = parts.join('，') || '无变化';
    return { clustered, updated, summary };
}

/**
 * v4.1.0: 检查单条记忆保存后是否需要触发聚类
 * 在策略 A 保存记忆后调用，异步不阻塞主流程
 */
export function scheduleClusterCheck(chatId) {
    setTimeout(async () => {
        try {
            const result = await checkAndClusterByTags(chatId);
            if (result.clustered > 0 || result.updated > 0) {
                console.log("[BB-Memory] 自动聚类: " + (result.summary));
            }
        } catch (e) {
            console.warn('[BB-Memory] 自动聚类检查失败:', e.message);
        }
    }, 5000); // 延迟 5 秒，避免干扰正在进行的提取
}
