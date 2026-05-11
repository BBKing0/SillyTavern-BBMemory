/**
 * world-book-importer.js —— BB-Memory v5.0 世界书导入
 *
 * 四柱架构适配：世界书条目分发到 NPC/物品/时间线/记忆。
 */

import { upsertNpcProfile, addItem, addMemory, getSettings } from './memory-store.js';
import { parseNpcResponse, parseItemResponse, parseTimelineResponse, parseMemoryResponse, callMainApi, callCustomApi } from './auto-generator.js';
import { normalizeNpcTier, normalizeItemTier } from './entity-tiers.js';

// ═══════════════════════════════════════════════════════════
//  条目提取（兼容多种世界书格式）
// ═══════════════════════════════════════════════════════════

function extractEntries(data) {
    if (data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)) {
        return Object.values(data.entries).filter(e => e && typeof e === 'object');
    }
    if (Array.isArray(data)) return data.filter(e => e && typeof e === 'object' && e.content);
    if (data.data?.character_book?.entries) return Object.values(data.data.character_book.entries);
    if (data.character_book?.entries) return Object.values(data.character_book.entries);
    if (data.entries && Array.isArray(data.entries)) return data.entries;
    return [];
}

// ═══════════════════════════════════════════════════════════
//  直接导入（AI 无关）
// ═══════════════════════════════════════════════════════════

export async function importWorldBook(chatId, jsonString) {
    const data = JSON.parse(jsonString);
    const entries = extractEntries(data);
    if (!entries.length) throw new Error('未找到有效的世界书条目。');

    let count = 0;
    for (const entry of entries) {
        if (!entry.content || !entry.content.trim()) continue;
        const content = entry.content.trim();
        const keywords = entry.key || [];
        const comment = entry.comment || '';
        const tags = keywords.filter(Boolean).map(k => ({ name: k.trim(), weight: 0.6 }));

        // 推断类型并分发到对应支柱
        const text = (content + ' ' + keywords.join(' ')).toLowerCase();

        if (/(?:角色|人物|npc|character|外貌|性格|身份|关系|relation)/.test(text)) {
            await upsertNpcProfile(chatId, {
                name: comment || keywords[0] || '未知角色',
                role: keywords.slice(0, 2).join(' ') || '',
                notes: [content],
                npcTier: entry.constant ? 'important' : 'minor',
                tags,
                source: 'worldbook',
            });
        } else if (/(?:物品|道具|武器|装备|item|weapon)/.test(text)) {
            await addItem(chatId, {
                name: comment || keywords[0] || '未知物品',
                significance: content,
                itemTier: entry.constant ? 'key' : 'consumable',
                tags,
                source: 'worldbook',
            });
        } else {
            await addMemory(chatId, {
                title: comment || keywords[0] || '',
                type: 'fact',
                content,
                summary: content.slice(0, 80),
                subject: keywords[0] || '',
                tags,
                source: 'worldbook',
            });
        }
        count++;
    }
    return count;
}

// ═══════════════════════════════════════════════════════════
//  AI 摘要导入
// ═══════════════════════════════════════════════════════════

export async function importWorldBookWithAI(chatId, jsonString) {
    const data = JSON.parse(jsonString);
    const entries = extractEntries(data);
    if (!entries.length) throw new Error('未找到有效的世界书条目。');

    const settings = getSettings();

    // 拼接所有条目为上下文
    const contextText = entries.map((entry, i) => {
        const keys = (entry.key || []).join(', ');
        const comment = entry.comment ? ` (${entry.comment})` : '';
        return `[条目${i + 1}${comment}]\n关键词: ${keys}\n内容: ${entry.content}`;
    }).join('\n\n');

    const prompt = `你是一个世界书记忆整理助手。请将以下世界书内容整理为结构化记忆，分四类输出：

规则：
1. NPC角色 → {"n":"角色名","r":"身份","p":"性格","a":"外貌","s":"状态","l":"位置","rt":[],"nt":"分级","ic":"","g":[]}
2. 物品 → {"n":"物品名","o":"持有者","s":"held","sig":"意义","kp":false,"it":"分级","g":[]}
3. 时间线 → {"t":"时间","e":"事件","p":[],"l":"地点","active":false,"imp":"影响","g":[]}
4. 记忆 → {"n":"标题","tp":"fact","m":"摘要","c":"内容","v":"","s":"","a":"","i":0.7,"e":0,"st":"","g":[]}

分级速查：NPC: core/important/minor/background | 物品: key/equipped/clue/consumable/background

返回JSON对象（不要markdown代码块）：{"npc":[...],"items":[...],"timeline":[...],"memories":[...]}

世界书内容：
${contextText}`;

    let responseText;
    if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
        responseText = await callCustomApi(prompt);
    } else {
        responseText = await callMainApi(prompt);
    }

    // 解析
    let text = responseText.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI 未返回有效的 JSON');
    const parsed = JSON.parse(match[0]);

    let count = 0;
    if (Array.isArray(parsed.npc)) {
        for (const n of parsed.npc) {
            await upsertNpcProfile(chatId, { ...n, source: 'worldbook-ai' });
            count++;
        }
    }
    if (Array.isArray(parsed.items)) {
        for (const i of parsed.items) {
            await addItem(chatId, { ...i, source: 'worldbook-ai' });
            count++;
        }
    }
    if (Array.isArray(parsed.timeline)) {
        const { upsertTimelineEntry } = await import('./memory-store.js');
        for (const t of parsed.timeline) {
            await upsertTimelineEntry(chatId, {
                storyTime: t.t || '', event: t.e || '', summary: t.e || '',
                participants: Array.isArray(t.p) ? t.p : [],
                location: t.l || '',
                isActive: t.active !== undefined ? t.active : false,
                status: t.active ? 'ongoing' : 'ended',
                impact: t.imp || '',
                tags: Array.isArray(t.g) ? t.g.map(x => ({ name: String(x), weight: 0.6 })) : [],
                source: 'worldbook-ai',
            });
            count++;
        }
    }
    if (Array.isArray(parsed.memories)) {
        for (const m of parsed.memories) {
            await addMemory(chatId, {
                title: m.n || '', type: m.tp || 'fact',
                summary: m.m || '', content: m.c || m.m || '',
                verbatim: m.v || '', subject: m.s || '', target: m.a || '',
                importance: typeof m.i === 'number' ? m.i : 0.7,
                emotionalWeight: typeof m.e === 'number' ? m.e : 0,
                storyTime: m.st || '',
                tags: Array.isArray(m.g) ? m.g.map(x => ({ name: String(x), weight: 0.6 })) : [],
                source: 'worldbook-ai',
            });
            count++;
        }
    }

    if (!count) throw new Error('AI 未能从世界书中提取到有效条目');
    return count;
}

// ═══════════════════════════════════════════════════════════
//  预览
// ═══════════════════════════════════════════════════════════

export function previewWorldBook(jsonString) {
    const data = JSON.parse(jsonString);
    const entries = extractEntries(data);
    return entries.map(entry => ({
        key: entry.key || [],
        content: (entry.content || '').slice(0, 100) + (entry.content?.length > 100 ? '...' : ''),
        comment: entry.comment || '',
        enabled: entry.enabled !== false,
    }));
}
