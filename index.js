/**
 * index.js —— BB-Memory v9.3.3 主入口
 *
 * 五柱架构编排器：NPC档案 / 物品栏 / 里程碑 / 记忆条目 / 实时记忆。
 * 负责初始化、拦截器、UI、斜杠命令。
 */

// ═══ 导入 ═══
import {
    MODULE_NAME, DEFAULT_SETTINGS, getSettings, updateSettings,
    getNpcProfiles, addNpcProfile, updateNpcProfile, removeNpcProfile, upsertNpcProfile,
    getItems, addItem, updateItem, removeItem, upsertItem,
    getMilestones, addMilestone, updateMilestone, removeMilestone, upsertMilestone,
    getTimeline,
    getMemories, addMemory, updateMemory, removeMemory,
    getRealtimeMemories, addRealtimeMemory, addRealtimeMemories,
    updateRealtimeMemory, removeRealtimeMemory, clearRealtimeMemories,
    clearAllData, deleteByExchange, getMemoryStats, refreshAllSourceFloors,
    exportMemoriesToChatMetadata, importMemoriesFromChatMetadata, cleanupChatMetadataBloat,
    migrateV4ToV5,
    exportMemories, importMemories, updateFactContent, addHiddenNote, removeHiddenNote,
    scheduleAutoBackup, recordHits,
    getCalendarDescription, setCalendarDescription,
} from './memory-store.js';

import {
    getRelevantMemories, getResidentMemories, buildMemoryInjectionPrompt,
    mergeExpandedRelevantResults, simpleSearch,
    getNpcForInjection, getItemsForInjection, getMilestonesForInjection, getTimelineForInjection,
    getRetrieverPromptTemplates,
} from './retriever.js';

import { MEMORY_TYPES, TRUTH_STATUS, REALTIME_KINDS, REALTIME_SETTLE_STATES } from './memory-types.js';
import { NPC_TIERS, ITEM_TIERS, expandMemoriesForEntityKeyword } from './entity-tiers.js';

import {
    initAutoGenerator, stopAutoGenerator, extractFromContext, saveExtractedCandidates,
    setAutoExtractProgressCallback, getPendingAutoCandidates, clearPendingAutoCandidates,
    callEmbeddingApi, embedExistingMemories,
    beginExtractionProgress, completeExtractionProgress, failExtractionProgress,
    reextractFloor,
    testApiConnection, getAutoGeneratorPromptTemplates,
} from './auto-generator.js';

import {
    syncMessageVisibility, refreshExtractionMarkers,
    markExchangeExtracted, unmarkExchangeProcessed, computeExchangeHash, cyrb53Hash,
    getExtractionFloorStatus, setPluginHiddenState,
} from './message-state.js';

import { getClueBoard, getClueBoardPromptTemplates } from './clue-board.js';
import { getMap } from './map-store.js';  // v8.7.0
import { hydrateCollectionEmbeddings, hydrateMapEmbeddings } from './vector-store.js';
import {
    DEFAULT_AGENT_SYSTEM_PROMPT,
    DEFAULT_CURATE_REVIEW_PROMPT,
    DEFAULT_HEALTH_TAG_PROMPT,
    DEFAULT_REALTIME_DETAIL_EXTRACT_PROMPT,
    DEFAULT_REALTIME_SETTLE_PROMPT,
    DEFAULT_THREAD_SUMMARY_PROMPT,
    getPromptTemplate,
    getPromptTemplates,
    isPromptTemplateCustomized,
    normalizePromptTemplatePatch,
} from './prompt-templates.js';

import {
    checkMaintenanceNeeded, dismissMaintenanceRemind,
    performMaintenance, autoMaintainSilent,
    fuzzyMemory, archiveMemory, restoreMemory,
    regenerateThreadSummary,
    getMaintenanceResolved, clearMaintenanceResolved,
} from './memory-maintainer.js';

import { runHealthCheck, buildHealthCheckPanel } from './memory-health-check.js';

import { openAssistant } from './memory-assistant.js';
import { openMemoryManager } from './memory-manager.js';
import {
    getCharacterId, listSlots, saveToSlot, loadFromSlot, createEmptySlot, deleteSlot,
    cloneSlot, getChatSlotDataSummary, bindChatToSlot, getBoundSlotName,
    claimSlotForChat, getSlotOwnerChatId,
} from './memory-slots.js';
import {
    getCharacterDisplayName, autoRescueSlots, primeIdentityCache,
} from './slot-identity.js';

// ═══ 常量 ═══
const INJECTION_KEY = 'bb_memory_injection';
const POSITION_IN_CHAT = 1; // in-chat
const ROLE_SYSTEM = 0;

// ═══ 全局状态 ═══
let lastRetrievalResult = null;
let settingsPanelMounted = false;
let lastObservedChatId = null;
let lastObservedCharId = null;
let chatSwitchFallbackTimer = null;
let chatSwitchFallbackRunning = false;
let chatSwitchPromptOpen = false;
let chatSwitchSuppressDeletesUntil = 0;
let sidebarRefreshTimer = null;
const handledChatSwitchPrompts = new Set();

const SETTINGS_EXPORT_VERSION = '9.3.3';
const SETTINGS_EXPORT_KEYS = [
    'enabled',
    'injectionTemplate', 'tokenBudget', 'tokenBudgetMode', 'maxResults', 'minScoreThreshold', 'floorRecentWindow',
    'npcInjectionMax', 'itemInjectionMax', 'milestoneVectorMax', 'milestoneDefaultInjectionMode',
    'mapInjectionMax', 'worldRealWorldRef', 'clueBoardInjectionEnabled',
    'autoGenEnabled', 'autoGenMode', 'autoGenEndpoint', 'autoGenModel',
    'maxMemoriesPerExchange', 'extractionConfirmMode', 'activeConfirmStyle', 'contextWindowExchanges',
    'batchExtractionCount', 'sourceRollbackFloorWindow', 'extractedMsgDisplay', 'extractionStyle',
    'extractionMessageTags',
    'customExtractionBias', 'customCorePrinciples', 'customExtractionDimensions', 'customPromptTemplates',
    'embeddingEnabled', 'embeddingEndpoint', 'embeddingModel', 'dedupEnabled', 'mergeSimilarityThreshold',
    'reduceSimilarityThreshold', 'entityDedupEnabled', 'entityMergeSimilarityThreshold',
    'dedupReviewSimilarityThreshold', 'dedupKnownEntityLimit', 'dedupAmbiguousAction',
    'diversityLimitPerTag', 'promotionCooldownRounds', 'hitScorePromoteThreshold', 'hitScoreEternalThreshold',
    'hitScoreDemoteThreshold', 'entityTierPromoteThreshold', 'entityTierDemoteThreshold',
    'maintenanceMode', 'maintenanceMemThreshold', 'maintenanceNpcThreshold', 'maintenanceItemThreshold', 'itemDustyMissRounds',
    'healthCheckDuplicateThreshold', 'healthCheckIsolationThreshold', 'healthCheckStaleDays',
    'healthCheckStaleHitThreshold', 'healthCheckThreadStaleDays', 'healthCheckClueStaleDays',
    // v9.3.3 AI 记忆整理
    'aiCurateEnabled', 'aiCurateTriggerMode',
    'aiCurateMemThreshold', 'aiCurateNpcThreshold', 'aiCurateItemThreshold',
    'aiCurateMilestoneThreshold', 'aiCurateTimelineThreshold',
    'aiCurateRecallPerEntry', 'aiCurateClusterThreshold', 'aiCurateMaxGroupsPerRun',
    'aiCurateAuthMerge', 'aiCurateAuthRewrite', 'aiCurateAuthSplit', 'aiCurateAuthDelete',
    'aiCurateUndoDepth', 'dedupTimeConflictScope',
    // v9.3.3 实时记忆（第五柱）
    'realtimeEnabled', 'realtimeExtractEnabled', 'realtimeExtractScope', 'realtimeExtractFirstN',
    'realtimeMaxDetailsPerFloor', 'realtimeTtlFloors', 'realtimeMaxEntries',
    'realtimeSceneChangeSettle', 'realtimeInjectionMax', 'realtimeInjectionTokenCap',
    'realtimePromotionMode', 'realtimeSettleMode',
    'timelineSummaryEnabled', 'maxActiveTimeline', 'autoBackupEnabled', 'chatMetadataBackupMaxKb', 'cloudVectorSlotMaxKb',
    'apiProfiles', 'activeApiProfile', 'categories', 'enabledCategories',
    'debugLogging',
];

const SETTING_CONTROL_BINDINGS = {
    enabled: ['#bb_memory_enabled', 'checkbox'],
    autoGenEnabled: ['#bb_auto_gen_enabled', 'checkbox'],
    embeddingEnabled: ['#bb_embedding_enabled', 'checkbox'],
    dedupEnabled: ['#bb_dedup_enabled', 'checkbox'],
    entityDedupEnabled: ['#bb_entity_dedup_enabled', 'checkbox'],
    debugLogging: ['#bb_debug_logging', 'checkbox'],
    timelineSummaryEnabled: ['#bb_timeline_summary_enabled', 'checkbox'],
    clueBoardInjectionEnabled: ['#bb_clue_board_injection_enabled', 'checkbox'],
    autoBackupEnabled: ['#bb_auto_backup_enabled', 'checkbox'],
    autoGenMode: ['#bb_auto_gen_mode', 'value'],
    extractionConfirmMode: ['#bb_extraction_confirm_mode', 'value'],
    activeConfirmStyle: ['#bb_active_confirm_style', 'value'],
    extractionStyle: ['#bb_extraction_style', 'value'],
    dedupAmbiguousAction: ['#bb_dedup_ambiguous_action', 'value'],
    contextWindowExchanges: ['#bb_context_window', 'value'],
    batchExtractionCount: ['#bb_batch_extraction', 'value'],
    maxMemoriesPerExchange: ['#bb_max_memories_per_exchange', 'value'],
    sourceRollbackFloorWindow: ['#bb_source_rollback_floor_window', 'value'],
    tokenBudget: ['#bb_token_budget', 'value'],
    tokenBudgetMode: ['#bb_token_budget_mode', 'value'],
    maxResults: ['#bb_max_results', 'value'],
    minScoreThreshold: ['#bb_min_score_threshold', 'value'],
    floorRecentWindow: ['#bb_floor_recent_window', 'value'],
    npcInjectionMax: ['#bb_npc_injection_max', 'value'],
    itemInjectionMax: ['#bb_item_injection_max', 'value'],
    milestoneVectorMax: ['#bb_milestone_vector_max', 'value'],
    milestoneDefaultInjectionMode: ['#bb_milestone_default_injection_mode', 'value'],
    mapInjectionMax: ['#bb_map_injection_max', 'value'],
    maintenanceMemThreshold: ['#bb_maintenance_mem_threshold', 'value'],
    maintenanceNpcThreshold: ['#bb_maintenance_npc_threshold', 'value'],
    maintenanceItemThreshold: ['#bb_maintenance_item_threshold', 'value'],
    itemDustyMissRounds: ['#bb_item_dusty_miss_rounds', 'value'],
    maintenanceMode: ['#bb_maintenance_mode', 'value'],
    diversityLimitPerTag: ['#bb_diversity_limit', 'value'],
    promotionCooldownRounds: ['#bb_promotion_cooldown_rounds', 'value'],
    hitScorePromoteThreshold: ['#bb_hit_score_promote_threshold', 'value'],
    hitScoreEternalThreshold: ['#bb_hit_score_eternal_threshold', 'value'],
    hitScoreDemoteThreshold: ['#bb_hit_score_demote_threshold', 'value'],
    entityTierPromoteThreshold: ['#bb_entity_tier_promote_threshold', 'value'],
    entityTierDemoteThreshold: ['#bb_entity_tier_demote_threshold', 'value'],
    maxActiveTimeline: ['#bb_max_active_timeline', 'value'],
    chatMetadataBackupMaxKb: ['#bb_chat_metadata_backup_max_kb', 'value'],
    cloudVectorSlotMaxKb: ['#bb_cloud_vector_slot_max_kb', 'value'],
    healthCheckDuplicateThreshold: ['#bb_health_check_duplicate_threshold', 'value'],
    healthCheckIsolationThreshold: ['#bb_health_check_isolation_threshold', 'value'],
    healthCheckStaleDays: ['#bb_health_check_stale_days', 'value'],
    healthCheckStaleHitThreshold: ['#bb_health_check_stale_hit_threshold', 'value'],
    healthCheckThreadStaleDays: ['#bb_health_check_thread_stale_days', 'value'],
    healthCheckClueStaleDays: ['#bb_health_check_clue_stale_days', 'value'],
    // v9.3.3 AI 记忆整理
    aiCurateEnabled: ['#bb_ai_curate_enabled', 'checkbox'],
    aiCurateTriggerMode: ['#bb_ai_curate_trigger_mode', 'value'],
    aiCurateMemThreshold: ['#bb_ai_curate_mem_threshold', 'value'],
    aiCurateNpcThreshold: ['#bb_ai_curate_npc_threshold', 'value'],
    aiCurateItemThreshold: ['#bb_ai_curate_item_threshold', 'value'],
    aiCurateMilestoneThreshold: ['#bb_ai_curate_milestone_threshold', 'value'],
    aiCurateTimelineThreshold: ['#bb_ai_curate_timeline_threshold', 'value'],
    aiCurateClusterThreshold: ['#bb_ai_curate_cluster_threshold', 'value'],
    aiCurateRecallPerEntry: ['#bb_ai_curate_recall_per_entry', 'value'],
    aiCurateMaxGroupsPerRun: ['#bb_ai_curate_max_groups', 'value'],
    aiCurateAuthMerge: ['#bb_ai_curate_auth_merge', 'value'],
    aiCurateAuthRewrite: ['#bb_ai_curate_auth_rewrite', 'value'],
    aiCurateAuthSplit: ['#bb_ai_curate_auth_split', 'value'],
    aiCurateAuthDelete: ['#bb_ai_curate_auth_delete', 'value'],
    aiCurateUndoDepth: ['#bb_ai_curate_undo_depth', 'value'],
    dedupTimeConflictScope: ['#bb_dedup_time_conflict_scope', 'value'],
    // v9.3.3 实时记忆（第五柱）
    realtimeEnabled: ['#bb_realtime_enabled', 'checkbox'],
    realtimeExtractEnabled: ['#bb_realtime_extract_enabled', 'checkbox'],
    realtimeExtractScope: ['#bb_realtime_extract_scope', 'value'],
    realtimeExtractFirstN: ['#bb_realtime_extract_first_n', 'value'],
    realtimeMaxDetailsPerFloor: ['#bb_realtime_max_details_per_floor', 'value'],
    realtimeTtlFloors: ['#bb_realtime_ttl_floors', 'value'],
    realtimeMaxEntries: ['#bb_realtime_max_entries', 'value'],
    realtimeSceneChangeSettle: ['#bb_realtime_scene_change_settle', 'checkbox'],
    realtimeInjectionMax: ['#bb_realtime_injection_max', 'value'],
    realtimeInjectionTokenCap: ['#bb_realtime_injection_token_cap', 'value'],
    realtimePromotionMode: ['#bb_realtime_promotion_mode', 'value'],
    realtimeSettleMode: ['#bb_realtime_settle_mode', 'value'],
    injectionTemplate: ['#bb_injection_template', 'value'],
    autoGenEndpoint: ['#bb_auto_gen_endpoint', 'value'],
    autoGenModel: ['#bb_auto_gen_model', 'value'],
    embeddingEndpoint: ['#bb_embedding_endpoint', 'value'],
    embeddingModel: ['#bb_embedding_model', 'value'],
    mergeSimilarityThreshold: ['#bb_merge_similarity_threshold', 'value'],
    reduceSimilarityThreshold: ['#bb_reduce_similarity_threshold', 'value'],
    entityMergeSimilarityThreshold: ['#bb_entity_merge_similarity_threshold', 'value'],
    dedupReviewSimilarityThreshold: ['#bb_dedup_review_similarity_threshold', 'value'],
    dedupKnownEntityLimit: ['#bb_dedup_known_entity_limit', 'value'],
    customExtractionBias: ['#bb_custom_extraction_bias', 'value'],
};

const EXTRACTION_MESSAGE_TAG_OPTIONS = Object.freeze(['content', 'context', 'status', 'thinking', 'note']);

function normalizeExtractionMessageTags(tags) {
    const source = Array.isArray(tags) ? tags : DEFAULT_SETTINGS.extractionMessageTags;
    const out = [];
    const seen = new Set();
    for (const raw of source || []) {
        const tag = String(raw || '')
            .trim()
            .replace(/^<\/?/, '')
            .replace(/>$/, '')
            .toLowerCase();
        if (!/^[a-z][\w:-]{0,63}$/.test(tag) || seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
    }
    return out;
}

function parseExtractionTagInput(text) {
    return normalizeExtractionMessageTags(String(text || '').split(/[,，\s]+/));
}

function syncExtractionTagControls(settings = getSettings()) {
    const selected = new Set(normalizeExtractionMessageTags(settings.extractionMessageTags));
    document.querySelectorAll('[data-bb-extract-tag]').forEach(input => {
        input.checked = selected.has(input.dataset.bbExtractTag);
    });
    const customInput = document.querySelector('#bb_extract_custom_tags');
    if (customInput) {
        customInput.value = [...selected]
            .filter(tag => !EXTRACTION_MESSAGE_TAG_OPTIONS.includes(tag))
            .join(', ');
    }
}

function readExtractionTagControls() {
    const tags = [];
    document.querySelectorAll('[data-bb-extract-tag]').forEach(input => {
        if (input.checked) tags.push(input.dataset.bbExtractTag);
    });
    const customTags = parseExtractionTagInput(document.querySelector('#bb_extract_custom_tags')?.value || '');
    return normalizeExtractionMessageTags([...tags, ...customTags]);
}

function bindExtractionTagControls() {
    const save = () => {
        updateSettings({ extractionMessageTags: readExtractionTagControls() });
        syncExtractionTagControls(getSettings());
    };
    document.querySelectorAll('[data-bb-extract-tag]').forEach(input => {
        input.addEventListener('change', save);
    });
    document.querySelector('#bb_extract_custom_tags')?.addEventListener('change', save);
    syncExtractionTagControls(getSettings());
}

function getPromptTemplateDefinitions() {
    return [
        {
            key: 'settings.injectionTemplate',
            settingKey: 'injectionTemplate',
            title: '注入总模板',
            category: '注入设置',
            description: '最终写入 SillyTavern extension prompt 的外层模板，{{memories}} 会替换为五柱/地图/线索板上下文。',
            defaultValue: DEFAULT_SETTINGS.injectionTemplate,
        },
        {
            key: 'agent.systemPrompt',
            title: '记忆管家 Agent 系统提示',
            category: 'Agent',
            description: '记忆管家 Agent 对话时使用，决定它如何读取、解释和执行记忆管理动作。',
            defaultValue: DEFAULT_AGENT_SYSTEM_PROMPT,
        },
        {
            key: 'maintenance.threadSummary',
            title: '时间线总结提示',
            category: '维护/总结',
            description: '点击刷新时间线总结时使用，把里程碑整理为命名时间线。',
            defaultValue: DEFAULT_THREAD_SUMMARY_PROMPT,
        },
        {
            key: 'health.tagSuggestion',
            title: '体检标签建议提示',
            category: '记忆体检',
            description: '记忆体检中为条目生成建议标签时使用。',
            defaultValue: DEFAULT_HEALTH_TAG_PROMPT,
        },
        {
            // v9.3.3 AI 整理师。定义写在这里而非 memory-curator.js，是为了让整理师保持懒加载。
            key: 'curate.review',
            title: 'AI 记忆整理审查',
            category: 'AI 整理师',
            description: '把聚类出的疑似重复分组交给 AI 判断合并/重写/拆分/删除/保留时使用。'
                + '可用占位符：{{fieldSpec}}（字段说明）{{groupsText}}（待整理分组）{{CONCRETE_TIME_RULE}} {{calRef}}。',
            defaultValue: DEFAULT_CURATE_REVIEW_PROMPT,
        },
        {
            // v9.3.3 实时细节抓取。定义内联在这里，让 realtime-memory.js 保持懒加载。
            key: 'realtime.detailExtract',
            title: '实时细节抓取',
            category: '实时记忆',
            description: '每层与主提取并行发起的轻量抓取提示词，只抓「当下有效的具体细节」（交通/衣着/在场/点的东西等）。'
                + '可用占位符：{{maxDetails}} {{location}} {{storyTime}} {{aiMessage}}。',
            defaultValue: DEFAULT_REALTIME_DETAIL_EXTRACT_PROMPT,
        },
        {
            // v9.3.3 场景结算。定义内联在这里，让 realtime-memory.js 保持懒加载。
            key: 'realtime.settle',
            title: '实时记忆场景结算',
            category: '实时记忆',
            description: '场景结束时判定每条临时细节的去向：晋升长期库 / 留档不注入 / 延长有效期。'
                + '可用占位符：{{location}} {{storyTime}} {{settleReason}} {{librarySummary}} {{pendingText}}。',
            defaultValue: DEFAULT_REALTIME_SETTLE_PROMPT,
        },
        ...getAutoGeneratorPromptTemplates(),
        ...getRetrieverPromptTemplates(),
        ...getClueBoardPromptTemplates(),
    ];
}

function getPromptTemplateAllowedKeys() {
    return getPromptTemplateDefinitions()
        .filter(def => !def.settingKey)
        .map(def => def.key);
}

function hashHitFrameText(text) {
    let h = 2166136261;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

function buildHitFrameKey(chatId, userFloor, userMessage) {
    return `${chatId || 'chat'}:${userFloor}:${hashHitFrameText(userMessage)}`;
}

// ═══════════════════════════════════════════════════════════
//  拦截器（核心）
// ═══════════════════════════════════════════════════════════

globalThis.bbMemoryInterceptor = async function (chat, contextSize, abort, type) {
    if (type === 'quiet') return chat;

    const settings = getSettings();
    if (!settings.enabled) { clearInjection(); return chat; }

    const ctx = SillyTavern.getContext();
    const chatId = ctx.chatId || (ctx.chat?.[0]?.chatId) || null;
    if (!chatId) { clearInjection(); return chat; }

    // v8.2.1 检测重roll：chat 末尾已是 AI 消息 → 正在覆盖已有回复
    let isReroll = false;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user) break;
        if (!chat[i].is_system && chat[i].mes?.trim()) { isReroll = true; break; }
    }

    // 1. 提取最后一条用户消息
    let userMessage = '';
    let userFloor = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && chat[i].mes?.trim()) {
            userMessage = chat[i].mes.trim();
            userFloor = i;
            break;
        }
    }
    if (!userMessage) { clearInjection(); return chat; }

    // 2. 上下文隐藏安全网 —— 用 ST 原生 is_system 隐藏已提取消息
    let hideChanged = false;
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (msg?._bbmem_extracted) {
            hideChanged = setPluginHiddenState(msg, i, true) || hideChanged;
        }
    }
    if (hideChanged) {
        try {
            if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
            else if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
            else if (typeof ctx.saveChat === 'function') ctx.saveChat();
        } catch { /* ignore */ }
    }

    // 3. 迁移检查
    if (!settings.migratedFromV4) {
        try { await migrateV4ToV5(chatId); } catch (e) { /* ignore */ }
    }

    // 4. 加载数据
    const [npc, items, milestones, memories, timeline, clueBoard, mapData, realtimeAll] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getMilestones(chatId), getMemories(chatId),
        getTimeline(chatId),
        getClueBoard(chatId),
        getMap(chatId),  // v8.7.0
        settings.realtimeEnabled === false ? Promise.resolve([]) : getRealtimeMemories(chatId),  // v9.3.3 第五柱
    ]);

    const hasMapData = Object.values(mapData?.locations || {}).some(loc => loc && !loc.archived);
    const activeClueBoard = settings.clueBoardInjectionEnabled === false ? null : clueBoard;
    const hasClueData = Array.isArray(activeClueBoard?.nodes) && activeClueBoard.nodes.length > 0;
    // v9.3.3 只有实时记忆也要注入：它不参与检索，是解决长线逻辑断裂的唯一通道
    const hasRealtimeData = Array.isArray(realtimeAll) && realtimeAll.length > 0;
    const hasData = npc.length + items.length + milestones.length + memories.length + timeline.length > 0
        || hasMapData || hasClueData || hasRealtimeData;
    if (!hasData) { clearInjection(); return chat; }

    try {
        await Promise.all([
            hydrateCollectionEmbeddings(chatId, npc),
            hydrateCollectionEmbeddings(chatId, items),
            hydrateCollectionEmbeddings(chatId, milestones),
            hydrateCollectionEmbeddings(chatId, timeline),
            hydrateCollectionEmbeddings(chatId, memories),
            hydrateMapEmbeddings(chatId, mapData),
        ]);
    } catch (e) {
        if (settings.debugLogging) console.warn('[BB-Memory] vector hydration skipped:', e.message || e);
    }

    // 5. 自动维护
    try { await autoMaintainSilent(chatId); } catch (e) { /* ignore */ }

    // 6. Embedding（如有）
    let queryEmbedding = null;
    if (settings.embeddingEnabled && settings.embeddingEndpoint) {
        try {
            queryEmbedding = await callEmbeddingApi(userMessage, 3000);
        } catch { /* 降级到关键词 */ }
    }

    // 7. 检索各支柱
    const npcForInjection = getNpcForInjection(npc, userMessage, queryEmbedding);
    const itemsForInjection = getItemsForInjection(items, userMessage, queryEmbedding);
    const milestoneForInjection = getMilestonesForInjection(milestones, userMessage, queryEmbedding);
    const timelineForInjection = settings.timelineSummaryEnabled
        ? getTimelineForInjection(timeline, settings.maxActiveTimeline ?? settings.maxActiveThreads ?? 5)
        : { text: '', timeline: [], threads: [] };
    const residentMems = getResidentMemories(memories);
    // v8.2.2 重roll 时扩大候选集 + 同分段局部 shuffle，保证质量不下降
    const relevantResults = getRelevantMemories(memories, userMessage, {
        maxResults: isReroll ? (settings.maxResults || 10) + 3 : (settings.maxResults || 10),
        minScore: settings.minScoreThreshold ?? 0.05,
        queryEmbedding,
    });
    const relevantWithResidents = mergeResidentMemoryResults(residentMems, relevantResults);
    const excludeIds = new Set([...npcForInjection.map(n => n.id), ...residentMems.map(m => m.id)]);
    for (const r of relevantWithResidents) excludeIds.add(r.memory.id);
    const merged = mergeExpandedRelevantResults(memories, userMessage, relevantWithResidents, excludeIds, 12, settings.maxResults, queryEmbedding);

    // v8.2.2 重roll 时仅对 L2/L3 同分段做局部 swap（相邻分数互换），不全局洗牌
    if (isReroll && merged.length > 2) {
        const l4 = merged.filter(r => r.level === 'L4');
        const rest = merged.filter(r => r.level !== 'L4');
        // 相邻分数分段两两 swap（保持整体质量顺序，仅微调同分段内位置）
        for (let i = 0; i < rest.length - 1; i++) {
            if (Math.abs(rest[i].score - rest[i + 1].score) < 0.08) {
                if (Math.random() < 0.5) [rest[i], rest[i + 1]] = [rest[i + 1], rest[i]];
            }
        }
        merged.length = 0;
        merged.push(...l4, ...rest);
    }

    if (!npcForInjection.length && !itemsForInjection.length &&
        !milestoneForInjection.ongoing.length && !milestoneForInjection.ended.length && !milestoneForInjection.foreshadow.length &&
        !merged.length && !timelineForInjection.text && !hasMapData && !hasClueData) {
        clearInjection(); return chat;
    }

    // 9. 构建注入文本
    const { text, tokenEstimate, stats, truncated, tokenBudget } = await buildMemoryInjectionPrompt({
        npcProfiles: npcForInjection,
        items: itemsForInjection,
        milestones: milestoneForInjection,
        timeline: timelineForInjection,
        relevantResults: merged,
        settings,
        chatLength: chat.length,
        clueBoard: activeClueBoard,
        mapData,  // v8.7.0
        queryText: userMessage,
        queryEmbedding,
        realtimeEntries: realtimeAll,  // v9.3.3 第五柱：无条件注入，不参与检索
    });
    if (!text.trim()) { clearInjection(); return chat; }

    // 8. 记录实际注入命中
    const injectedNpcIds = Array.isArray(stats.npcIds) ? new Set(stats.npcIds) : null;
    const injectedItemIds = Array.isArray(stats.itemIds) ? new Set(stats.itemIds) : null;
    const injectedMilestoneIds = Array.isArray(stats.milestoneIds) ? new Set(stats.milestoneIds) : null;
    const injectedTimelineIds = Array.isArray(stats.timelineIds) ? new Set(stats.timelineIds) : null;
    const injectedMemoryIds = Array.isArray(stats.memoryIds) ? new Set(stats.memoryIds) : null;
    const hitRecords = [];
    for (const n of npcForInjection) if (!injectedNpcIds || injectedNpcIds.has(String(n.id))) hitRecords.push({ collection: 'npc', id: n.id });
    for (const i of itemsForInjection) if (!injectedItemIds || injectedItemIds.has(String(i.id))) hitRecords.push({ collection: 'item', id: i.id });
    for (const t of [...milestoneForInjection.foreshadow, ...milestoneForInjection.ongoing, ...milestoneForInjection.ended]) {
        if (!injectedMilestoneIds || injectedMilestoneIds.has(String(t.id))) hitRecords.push({ collection: 'milestone', id: t.id });
    }
    for (const r of merged) if (!injectedMemoryIds || injectedMemoryIds.has(String(r.memory.id))) hitRecords.push({ collection: 'mem', id: r.memory.id });
    for (const id of stats.mapLocationIds || []) hitRecords.push({ collection: 'map', id });
    const hitFrameKey = buildHitFrameKey(chatId, userFloor, userMessage);
    const hitFrameMsg = userFloor >= 0 ? chat[userFloor] : null;
    const suppressHitScore = isMetaDialogueHitFrame(chat, userFloor);
    if (suppressHitScore) {
        clearHitFrameMetadataLocal(hitFrameMsg);
        if (settings.debugLogging) console.log(`[BB-Memory] skip meta-dialogue hit frame: ${hitFrameKey}`);
    } else {
        await recordInjectionHitFrame(chatId, hitFrameMsg, hitFrameKey, hitRecords, ctx, settings);
    }

    // 10. 注入
    const injectionText = (settings.injectionTemplate || '[BB-Memory 长期记忆]\n{{memories}}')
        .replace('{{memories}}', text);
    ctx.setExtensionPrompt(INJECTION_KEY, injectionText, POSITION_IN_CHAT, 4, ROLE_SYSTEM);

    if (truncated.length > 0) {
        console.warn(`[BB-Memory] 注入token预算(${tokenBudget})不足，以下区块被截断: ${truncated.join(', ')} | 已用~${tokenEstimate} tokens`);
    }

    if (settings.debugLogging) {
        const prefix = isReroll ? '[BB-Memory] 重roll注入' : '[BB-Memory] 注入';
        const realtimeNote = stats.realtimeEntryCount
            ? ` 实时${stats.realtimeEntryCount}/${stats.realtimeTotalCount}(~${stats.realtimeTokens}t)`
            : '';
        console.log(`${prefix}: 时间线${stats.timelineCount || 0} NPC${stats.npcCount} 物品${stats.itemCount} 里程碑${stats.milestoneCount || 0} 记忆${stats.memoryCount} 地图${stats.mapCount || 0}${stats.clueBoard ? ' 线索板1' : ''}${realtimeNote} | ~${tokenEstimate} tokens`);
    }

    // 11. 存储命中追踪
    const injectedMerged = injectedMemoryIds ? merged.filter(r => injectedMemoryIds.has(String(r.memory.id))) : merged;
    const injectedNpcs = injectedNpcIds ? npcForInjection.filter(n => injectedNpcIds.has(String(n.id))) : npcForInjection;
    const injectedItems = injectedItemIds ? itemsForInjection.filter(i => injectedItemIds.has(String(i.id))) : itemsForInjection;
    const filterMilestoneHits = (entries) => injectedMilestoneIds ? entries.filter(t => injectedMilestoneIds.has(String(t.id))) : entries;
    const filterTimelineHits = (entries) => injectedTimelineIds ? entries.filter(t => injectedTimelineIds.has(String(t.id))) : entries;

    const memoryHitRecords = injectedMerged.map(r => ({
        id: r.memory.id,
        title: r.memory.title,
        type: r.memory.type,
        score: r.score,
        level: r.level,
        memoryTier: r.memory.memoryTier || '',
    }));
    const visibleMemoryHits = memoryHitRecords.filter(h => h.memoryTier !== 'eternal');
    const eternalInjectedCount = memoryHitRecords.length - visibleMemoryHits.length;

    lastRetrievalResult = {
        chatId, timestamp: Date.now(),
        hits: visibleMemoryHits,
        memoryHitsAll: memoryHitRecords,
        eternalInjectedCount,
        npcHits: injectedNpcs.map(n => ({ id: n.id, name: n.name, npcTier: n.npcTier })),
        itemHits: injectedItems.map(i => ({ id: i.id, name: i.name, itemTier: i.itemTier })),
        milestoneHits: {
            foreshadow: filterMilestoneHits(milestoneForInjection.foreshadow).map(t => ({ id: t.id, title: t.title || t.event, status: t.status, injectionMode: t.injectionMode || 'resident' })),
            ongoing: filterMilestoneHits(milestoneForInjection.ongoing).map(t => ({ id: t.id, title: t.title || t.event, status: t.status, injectionMode: t.injectionMode || 'resident' })),
            ended: filterMilestoneHits(milestoneForInjection.ended).map(t => ({ id: t.id, title: t.title || t.event, status: t.status, injectionMode: t.injectionMode || 'resident' })),
        },
        timelineHits: filterTimelineHits(timelineForInjection.timeline || timelineForInjection.threads || [])
            .map(t => ({ id: t.id, title: t.name || t.title || t.summary, status: t.status, priority: t.priority })),
        mapHits: (stats.mapLocationIds || []).map(id => {
            const loc = mapData?.locations?.[id];
            return loc ? { id, name: loc.name, region: loc.region } : { id, name: id, region: '' };
        }),
        stats,
    };
    // 同步侧边栏命中列表
    setTimeout(() => updateSidebarHitList(), 50);

    // 12. Active 模式：显示审核面板
    if (settings.extractionConfirmMode === 'active' && settings.activeConfirmStyle === 'popup') {
        const pending = getPendingAutoCandidates();
        if (pending.length) {
            showFloatingReviewPanel(chatId, pending);
            clearPendingAutoCandidates();
        }
    }

    // ST 原生跳过 is_system 消息，已由 syncMessageVisibility 处理

    return chat;
};

function clearInjection() {
    try {
        SillyTavern.getContext().setExtensionPrompt(INJECTION_KEY, '', POSITION_IN_CHAT, 0, ROLE_SYSTEM);
    } catch { /* ignore */ }
}

function mergeResidentMemoryResults(residentMems, relevantResults) {
    const byId = new Map();
    for (const mem of residentMems || []) {
        if (!mem?.id) continue;
        byId.set(mem.id, { memory: mem, score: 1.0, breakdown: { resident: 1 }, level: 'L4' });
    }
    for (const result of relevantResults || []) {
        const id = result?.memory?.id;
        if (!id || byId.has(id)) continue;
        byId.set(id, result);
    }
    return [...byId.values()];
}

// ═══════════════════════════════════════════════════════════
//  悬浮审核面板（Active 模式）
// ═══════════════════════════════════════════════════════════

function getReviewGroup(candidate) {
    if (candidate?.group) return candidate.group;
    const pillar = candidate?.pillar || 'memory';
    if (pillar === 'milestone' || pillar === 'timeline_entry') return 'milestone';
    if (pillar === 'thread' || pillar === 'timeline') return 'timeline';
    if (pillar === 'item') return 'item';
    if (pillar === 'location' || pillar === 'map') return 'location';
    if (pillar === 'npc') return 'npc';
    return 'memory';
}

function getReviewPillarLabel(candidate) {
    if (candidate?.label) return candidate.label;
    const labels = {
        npc: 'NPC',
        item: '物品',
        milestone: '里程碑',
        timeline: '时间线',
        thread: '时间线',
        location: '地点',
        memory: '记忆',
    };
    return labels[candidate?.pillar] || '记忆';
}

function formatReviewSaveResult(result) {
    const parts = [
        result.npc ? `NPC ${result.npc}` : '',
        result.items ? `物品 ${result.items}` : '',
        result.milestones ? `里程碑 ${result.milestones}` : '',
        result.timeline ? `时间线 ${result.timeline}` : '',
        result.locations ? `地点 ${result.locations}` : '',
        result.memories ? `记忆 ${result.memories}` : '',
    ].filter(Boolean);
    if (result.merged) parts.push(`合并 ${result.merged}`);
    if (result.skipped) parts.push(`跳过 ${result.skipped}`);
    return parts.join(' / ') || '无新增写入';
}

function showFloatingReviewPanel(chatId, candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return;
    document.getElementById('bb_active_review_overlay')?.remove();

    const groups = [
        { key: 'all', label: '全部' },
        { key: 'npc', label: 'NPC' },
        { key: 'item', label: '物品' },
        { key: 'milestone', label: '里程碑' },
        { key: 'timeline', label: '时间线' },
        { key: 'location', label: '地点' },
        { key: 'memory', label: '记忆' },
    ];
    const state = candidates.map((candidate, index) => ({
        ...candidate,
        _reviewId: candidate.id || `bb_review_${Date.now()}_${index}`,
        _reviewIndex: index,
        _reviewGroup: getReviewGroup(candidate),
        selected: candidate._selected !== false && candidate.selected !== false,
        _selected: candidate._selected !== false && candidate.selected !== false,
    }));
    let activeGroup = 'all';
    let saving = false;

    const overlay = document.createElement('div');
    overlay.id = 'bb_active_review_overlay';
    overlay.className = 'bb-active-review-overlay';
    overlay.innerHTML = `
        <div class="bb-active-review-panel">
            <div class="bb-active-review-header">
                <div>
                    <div class="bb-active-review-title"><i class="fa-solid fa-clipboard-check"></i> 主动审核候选</div>
                    <div class="bb-active-review-subtitle">保存前请逐条确认，未勾选项不会入库。</div>
                </div>
                <button class="menu_button bb-active-review-close" type="button" title="关闭">×</button>
            </div>
            <div class="bb-active-review-tabs"></div>
            <div class="bb-active-review-toolbar">
                <button class="menu_button" type="button" data-action="select_visible">全选当前</button>
                <button class="menu_button" type="button" data-action="invert_visible">反选当前</button>
                <span class="bb-active-review-status"></span>
            </div>
            <div class="bb-active-review-list"></div>
            <div class="bb-active-review-footer">
                <button class="menu_button danger" type="button" data-action="discard">全部丢弃</button>
                <button class="menu_button" type="button" data-action="save">保存选中</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const tabEl = overlay.querySelector('.bb-active-review-tabs');
    const listEl = overlay.querySelector('.bb-active-review-list');
    const statusEl = overlay.querySelector('.bb-active-review-status');
    const saveBtn = overlay.querySelector('[data-action="save"]');
    const discardBtn = overlay.querySelector('[data-action="discard"]');

    const visibleCandidates = () => state.filter(c => activeGroup === 'all' || c._reviewGroup === activeGroup);
    const selectedCount = () => state.filter(c => c.selected).length;

    function updateStatus(text) {
        if (text) {
            statusEl.textContent = text;
            return;
        }
        statusEl.textContent = `已选 ${selectedCount()} / ${state.length}`;
    }

    function renderTabs() {
        const counts = groups.reduce((acc, group) => {
            acc[group.key] = group.key === 'all'
                ? state.length
                : state.filter(c => c._reviewGroup === group.key).length;
            return acc;
        }, {});
        tabEl.innerHTML = groups.map(group => `
            <button class="bb-active-review-tab ${activeGroup === group.key ? 'active' : ''}" type="button" data-group="${group.key}" ${counts[group.key] ? '' : 'disabled'}>
                ${escapeHtml(group.label)} <span>${counts[group.key]}</span>
            </button>
        `).join('');
    }

    function renderList() {
        const visible = visibleCandidates();
        if (!visible.length) {
            listEl.innerHTML = '<div class="bb-active-review-empty">这一类没有候选项。</div>';
            updateStatus();
            return;
        }
        listEl.innerHTML = visible.map(candidate => {
            const source = Number.isInteger(candidate.sourceFloor) ? `第 ${candidate.sourceFloor} 楼` : '';
            const type = [getReviewPillarLabel(candidate), candidate.type].filter(Boolean).join(' / ');
            return `
                <label class="bb-active-review-item" data-index="${candidate._reviewIndex}">
                    <input type="checkbox" ${candidate.selected ? 'checked' : ''} />
                    <div class="bb-active-review-item-body">
                        <div class="bb-active-review-item-head">
                            <span class="bb-active-review-type">${escapeHtml(type)}</span>
                            ${source ? `<span class="bb-active-review-source">${escapeHtml(source)}</span>` : ''}
                        </div>
                        <div class="bb-active-review-item-title">${escapeHtml(candidate.title || '(无标题)')}</div>
                        <div class="bb-active-review-item-summary">${escapeHtml(candidate.summary || '')}</div>
                    </div>
                </label>
            `;
        }).join('');
        updateStatus();
    }

    function render() {
        renderTabs();
        renderList();
    }

    function setBusy(nextSaving) {
        saving = nextSaving;
        if (!nextSaving) {
            render();
            return;
        }
        overlay.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
    }

    tabEl.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-group]');
        if (!btn || btn.disabled || saving) return;
        activeGroup = btn.dataset.group || 'all';
        render();
    });

    listEl.addEventListener('change', (event) => {
        const checkbox = event.target.closest('input[type="checkbox"]');
        const item = event.target.closest('[data-index]');
        if (!checkbox || !item) return;
        const candidate = state[Number(item.dataset.index)];
        if (candidate) {
            candidate.selected = checkbox.checked;
            candidate._selected = checkbox.checked;
        }
        updateStatus();
    });

    overlay.querySelector('[data-action="select_visible"]').addEventListener('click', () => {
        visibleCandidates().forEach(c => { c.selected = true; c._selected = true; });
        renderList();
    });
    overlay.querySelector('[data-action="invert_visible"]').addEventListener('click', () => {
        visibleCandidates().forEach(c => { c.selected = !c.selected; c._selected = c.selected; });
        renderList();
    });
    overlay.querySelector('.bb-active-review-close').addEventListener('click', () => {
        overlay.remove();
        showToast(`已暂时关闭审核面板，${state.length} 条候选未保存`, 'info');
    });
    discardBtn.addEventListener('click', () => {
        overlay.remove();
        showToast(`已丢弃 ${state.length} 条候选`, 'info');
    });
    saveBtn.addEventListener('click', async () => {
        const selected = state.filter(c => c.selected);
        if (!selected.length) {
            showToast('请至少勾选一条候选再保存', 'warning');
            return;
        }
        try {
            setBusy(true);
            updateStatus(`正在保存 0 / ${selected.length}...`);
            const result = await saveExtractedCandidates(chatId, selected.map(c => ({ ...c, selected: true, _selected: true })), (done, total) => {
                updateStatus(`正在保存 ${done} / ${total}...`);
            });
            overlay.remove();
            const summary = formatReviewSaveResult(result);
            showToast(`审核保存完成：${summary}`, result.total ? 'success' : 'info');
            recordActivity('success', '主动审核保存完成', summary);
        } catch (e) {
            setBusy(false);
            updateStatus();
            showToast(`审核保存失败: ${e.message || '未知错误'}`, 'error');
        }
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay && !saving) {
            overlay.remove();
            showToast(`已暂时关闭审核面板，${state.length} 条候选未保存`, 'info');
        }
    });

    render();
}

// ═══════════════════════════════════════════════════════════
//  UI 辅助
// ═══════════════════════════════════════════════════════════

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
}

function recordActivity(type = 'info', title = '运行记录', message = '', details = '') {
    try {
        const s = getSettings();
        const current = Array.isArray(s.activityLog) ? s.activityLog : [];
        const entry = {
            id: 'act_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
            type,
            title: String(title || '运行记录').slice(0, 60),
            message: String(message || '').slice(0, 300),
            details: details ? String(details).slice(0, 600) : '',
            timestamp: Date.now(),
        };
        updateSettings({ activityLog: [entry, ...current].slice(0, 50) });
    } catch { /* ignore */ }
}

globalThis.bbMemoryRecordActivity = recordActivity;

function sanitizeApiProfilesForExport(profiles) {
    if (!Array.isArray(profiles)) return [];
    return profiles.map(p => ({
        name: p?.name || '',
        endpoint: p?.endpoint || '',
        model: p?.model || '',
        embeddingEndpoint: p?.embeddingEndpoint || '',
        embeddingModel: p?.embeddingModel || '',
    })).filter(p => p.name);
}

function mergeImportedApiProfiles(importedProfiles, existingProfiles = []) {
    if (!Array.isArray(importedProfiles)) return existingProfiles;
    const existingByName = new Map((existingProfiles || []).map(p => [p.name, p]));
    return importedProfiles
        .map(p => {
            const old = existingByName.get(p?.name);
            return {
                name: p?.name || '',
                endpoint: p?.endpoint || '',
                key: old?.key || '',
                model: p?.model || '',
                embeddingEndpoint: p?.embeddingEndpoint || '',
                embeddingKey: old?.embeddingKey || '',
                embeddingModel: p?.embeddingModel || '',
            };
        })
        .filter(p => p.name);
}

function buildSettingsExportPayload() {
    const settings = getSettings();
    const exported = {};
    for (const key of SETTINGS_EXPORT_KEYS) {
        if (!(key in settings)) continue;
        if (key === 'apiProfiles') {
            exported.apiProfiles = sanitizeApiProfilesForExport(settings.apiProfiles);
        } else if (key === 'customPromptTemplates') {
            exported.customPromptTemplates = normalizePromptTemplatePatch(settings.customPromptTemplates, getPromptTemplateAllowedKeys());
        } else {
            exported[key] = structuredClone(settings[key]);
        }
    }
    const customPromptTemplates = exported.customPromptTemplates || {};
    return {
        type: 'bb-memory-settings',
        version: SETTINGS_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        note: 'API keys are intentionally excluded. customPromptTemplates contains only edited prompt templates.',
        promptTemplates: {
            custom: customPromptTemplates,
            customizedKeys: Object.keys(customPromptTemplates),
        },
        settings: exported,
    };
}

function normalizeImportedSettingsPayload(payload) {
    const source = payload?.settings && typeof payload.settings === 'object' ? payload.settings : payload;
    if (!source || typeof source !== 'object') throw new Error('不是有效的 BB-Memory 设置文件');
    const current = getSettings();
    const patch = {};
    for (const key of SETTINGS_EXPORT_KEYS) {
        if (!(key in source)) continue;
        if (key === 'apiProfiles') {
            patch.apiProfiles = mergeImportedApiProfiles(source.apiProfiles, current.apiProfiles || []);
        } else if (key === 'customPromptTemplates') {
            patch.customPromptTemplates = normalizePromptTemplatePatch(source.customPromptTemplates, getPromptTemplateAllowedKeys());
        } else {
            patch[key] = structuredClone(source[key]);
        }
    }
    if (payload?.promptTemplates) {
        const promptSource = payload.promptTemplates.custom || payload.promptTemplates;
        patch.customPromptTemplates = normalizePromptTemplatePatch(promptSource, getPromptTemplateAllowedKeys());
    }
    delete patch.autoGenApiKey;
    delete patch.embeddingApiKey;
    return patch;
}

function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function syncSettingsControls(settings = getSettings()) {
    for (const [key, [selector, mode]] of Object.entries(SETTING_CONTROL_BINDINGS)) {
        const el = document.querySelector(selector);
        if (!el || !(key in settings)) continue;
        if (mode === 'checkbox') el.checked = !!settings[key];
        else el.value = settings[key] ?? '';
    }
    const styleSelect = document.querySelector('#bb_extraction_style');
    const customBiasSection = document.querySelector('#bb_custom_bias_section');
    if (styleSelect && customBiasSection) {
        customBiasSection.style.display = styleSelect.value === 'custom' ? '' : 'none';
    }
    syncExtractionTagControls(settings);
    renderPromptTemplateList(settings);
}

function getPromptDefinitionValue(def, settings = getSettings()) {
    if (def.settingKey) return settings[def.settingKey] ?? def.defaultValue ?? '';
    return getPromptTemplate(settings, def.key, def.defaultValue || '', { legacyKey: def.legacySettingKey });
}

function isPromptDefinitionCustomized(def, settings = getSettings()) {
    if (def.settingKey) return String(settings[def.settingKey] ?? '') !== String(def.defaultValue ?? '');
    return isPromptTemplateCustomized(settings, def.key, { legacyKey: def.legacySettingKey });
}

function getPromptOpenState() {
    try {
        const raw = localStorage.getItem('bb_memory_prompt_template_open');
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
}

function setPromptOpenState(key, open) {
    try {
        const state = getPromptOpenState();
        state[key] = !!open;
        localStorage.setItem('bb_memory_prompt_template_open', JSON.stringify(state));
    } catch { /* ignore */ }
}

function savePromptTemplateValue(def, value) {
    const settings = getSettings();
    if (def.settingKey) {
        const nextValue = String(value || '').trim() ? value : def.defaultValue;
        updateSettings({ [def.settingKey]: nextValue });
        return;
    }
    const templates = { ...getPromptTemplates(settings) };
    if (!String(value || '').trim() || String(value) === String(def.defaultValue || '')) {
        delete templates[def.key];
    } else {
        templates[def.key] = String(value);
    }
    const patch = { customPromptTemplates: templates };
    if (def.legacySettingKey) patch[def.legacySettingKey] = '';
    updateSettings(patch);
}

function resetPromptTemplateValue(def) {
    const settings = getSettings();
    if (def.settingKey) {
        updateSettings({ [def.settingKey]: def.defaultValue || '' });
        return;
    }
    const templates = { ...getPromptTemplates(settings) };
    delete templates[def.key];
    const patch = { customPromptTemplates: templates };
    if (def.legacySettingKey) patch[def.legacySettingKey] = '';
    updateSettings(patch);
}

function renderPromptTemplateList(settings = getSettings()) {
    const container = document.querySelector('#bb_prompt_template_list');
    if (!container) return;
    const definitions = getPromptTemplateDefinitions();
    const openState = getPromptOpenState();
    container.innerHTML = definitions.map((def, idx) => {
        const value = getPromptDefinitionValue(def, settings);
        const customized = isPromptDefinitionCustomized(def, settings);
        const isOpen = openState[def.key] === true;
        return `
            <div class="bb-prompt-template-card ${isOpen ? 'open' : ''}" data-key="${escapeHtml(def.key)}" data-index="${idx}">
                <button type="button" class="bb-prompt-template-head" data-action="toggle">
                    <span class="bb-prompt-template-title">
                        <i class="fa-solid ${isOpen ? 'fa-chevron-down' : 'fa-chevron-right'}"></i>
                        ${escapeHtml(def.title || def.key)}
                    </span>
                    <span class="bb-prompt-template-badge ${customized ? 'custom' : ''}">${customized ? '已自定义' : '默认'}</span>
                </button>
                <div class="bb-prompt-template-meta">${escapeHtml(def.category || '提示词')} · ${escapeHtml(def.description || '')}</div>
                <div class="bb-prompt-template-body" style="${isOpen ? '' : 'display:none;'}">
                    <textarea class="bb-input bb-prompt-template-text" rows="8" readonly spellcheck="false">${escapeHtml(value)}</textarea>
                    <div class="bb-prompt-template-actions">
                        <button type="button" class="menu_button bb-prompt-template-edit" data-action="edit"><i class="fa-solid fa-pen"></i> 编辑</button>
                        <button type="button" class="menu_button bb-prompt-template-reset" data-action="reset"><i class="fa-solid fa-rotate-left"></i> 恢复默认</button>
                    </div>
                </div>
            </div>`;
    }).join('');

    container.querySelectorAll('.bb-prompt-template-card').forEach(card => {
        const def = definitions[Number(card.dataset.index)];
        const body = card.querySelector('.bb-prompt-template-body');
        const textarea = card.querySelector('.bb-prompt-template-text');
        const editBtn = card.querySelector('.bb-prompt-template-edit');
        const toggle = () => {
            const isOpen = body.style.display === 'none';
            body.style.display = isOpen ? '' : 'none';
            card.classList.toggle('open', isOpen);
            const icon = card.querySelector('.bb-prompt-template-title i');
            if (icon) icon.className = `fa-solid ${isOpen ? 'fa-chevron-down' : 'fa-chevron-right'}`;
            setPromptOpenState(def.key, isOpen);
        };
        card.querySelector('[data-action="toggle"]')?.addEventListener('click', toggle);
        editBtn?.addEventListener('click', () => {
            if (textarea.readOnly) {
                textarea.readOnly = false;
                textarea.focus();
                editBtn.innerHTML = '<i class="fa-solid fa-check"></i> 保存';
                card.classList.add('editing');
                return;
            }
            savePromptTemplateValue(def, textarea.value);
            showToast(`提示词「${def.title}」已保存`, 'success');
            syncSettingsControls(getSettings());
        });
        card.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
            resetPromptTemplateValue(def);
            showToast(`提示词「${def.title}」已恢复默认`, 'info');
            syncSettingsControls(getSettings());
        });
    });
}

function isMetaDialogueHitFrame(chat, userFloor) {
    if (!Array.isArray(chat) || userFloor < 0 || userFloor >= chat.length) return false;
    const userMsg = chat[userFloor];
    if (userMsg?._bbmem_meta_marker || userMsg?._bbmem_meta_pair || userMsg?._bbmem_skipped) return true;
    for (let i = userFloor + 1; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;
        if (msg.is_user) break;
        if (msg._bbmem_meta_marker || msg._bbmem_meta_pair || msg._bbmem_skipped) return true;
    }
    return false;
}

function saveHitFrameChat(ctx) {
    try {
        if (typeof ctx?.saveChatDebounced === 'function') ctx.saveChatDebounced();
        else if (typeof ctx?.saveChat === 'function') ctx.saveChat();
    } catch { /* ignore */ }
}

async function recordInjectionHitFrame(chatId, msg, frameKey, hitRecords, ctx, settings) {
    if (!chatId || !frameKey) return false;
    const isSameFrame = msg && msg._bbmem_hitFrameKey === frameKey;
    const alreadyHandled = isSameFrame && (msg._bbmem_hitAppliedKey === frameKey || msg._bbmem_hitRecordingKey === frameKey);
    if (alreadyHandled) {
        if (settings.debugLogging) console.log(`[BB-Memory] skip repeated hit frame: ${frameKey}`);
        return false;
    }

    if (msg) {
        msg._bbmem_hitFrameKey = frameKey;
        msg._bbmem_hitRecords = (hitRecords || []).map(h => `${h.collection}:${h.id}`);
        msg._bbmem_hitRecordedAt = Date.now();
        msg._bbmem_hitRecordingKey = frameKey;
        saveHitFrameChat(ctx);
    }

    try {
        const result = await recordHits(chatId, hitRecords, { countMisses: true, frameKey });
        if (msg && msg._bbmem_hitFrameKey === frameKey) {
            msg._bbmem_hitAppliedKey = frameKey;
            delete msg._bbmem_hitRecordingKey;
            saveHitFrameChat(ctx);
        }
        if (settings.debugLogging) {
            const total = (hitRecords || []).length;
            const updated = result?.updated?.length || 0;
            const mapText = result?.mapChanged ? ' map+1' : '';
            console.log(`[BB-Memory] recorded hit frame: ${frameKey} hits=${total} updated=${updated}${mapText}`);
        }
        return true;
    } catch (err) {
        if (msg && msg._bbmem_hitFrameKey === frameKey) {
            delete msg._bbmem_hitRecordingKey;
            saveHitFrameChat(ctx);
        }
        console.warn('[BB-Memory] 命中升降格记录失败:', err?.message || err);
        return false;
    }
}

function clearHitFrameMetadataLocal(msg) {
    if (!msg || typeof msg !== 'object') return;
    delete msg._bbmem_hitFrameKey;
    delete msg._bbmem_hitRecords;
    delete msg._bbmem_hitRecordedAt;
    delete msg._bbmem_hitAppliedKey;
    delete msg._bbmem_hitRecordingKey;
}

function formatCompactFloorRange(floors = []) {
    const sorted = [...new Set(floors)]
        .filter(n => Number.isInteger(n) && n >= 0)
        .sort((a, b) => a - b);
    if (!sorted.length) return '无';
    const parts = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const n = sorted[i];
        if (n === prev + 1) {
            prev = n;
            continue;
        }
        parts.push(start === prev ? String(start) : `${start}-${prev}`);
        start = prev = n;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    return parts.join('、');
}

function shouldRecordToast(msg, type) {
    if (type === 'error' || type === 'warning' || type === 'success') return true;
    return /提醒|完成|失败|跳过|清理|标记|提取|备份|恢复|维护|连接|初始化/.test(String(msg || ''));
}

function formatHubIdleStatus(status) {
    if (!status || !status.total) return '空闲';
    const latest = status.latestExtracted?.length
        ? (status.latestExtractedText || formatCompactFloorRange(status.latestExtracted))
        : '';
    return latest ? `空闲\n最新提取楼层 ${latest}` : '空闲';
}

function formatHubBusyStatus(status, fallback = '') {
    if (status?.pending?.length) return `正在提取${formatCompactFloorRange(status.pending)}层`;
    const text = String(fallback || '').replace(/^提取状态[:：]?\s*/, '').replace(/^提取中[-：:]?\s*/, '');
    return text || '正在提取';
}

const EXTRACTION_MODE_TEXT = Object.freeze({
    auto: '自动提取',
    manual: '手动提取',
    switch: '换楼提取',
    retry: '重新提取',
});

function formatExtractionTaskFloors(info = {}) {
    const floors = Array.isArray(info.floors) && info.floors.length
        ? info.floors
        : (Number.isInteger(info.floor) ? [info.floor] : []);
    if (!floors.length) return '';
    const range = formatCompactFloorRange(floors);
    return floors.length === 1 ? `第 ${range} 层` : `${range} 层`;
}

function formatExtractionProgressLabel(info = {}, compact = false) {
    const mode = EXTRACTION_MODE_TEXT[info.mode] || '提取';
    const floors = formatExtractionTaskFloors(info);
    const prefix = `${mode}${floors ? ` ${floors}` : ''}`;
    const text = String(info.text || '').replace(/^提取状态[:：]?\s*/, '').trim();
    const failed = info.state === 'failed';
    const done = info.state === 'done';
    if (failed) return `${prefix}失败${text ? ` · ${text.replace(/^.*?失败[:：]?\s*/, '')}` : ''}`;
    if (done) return `${prefix}完成${text && !/^(提取|自动提取|手动提取|换楼提取|重新提取)?完成/.test(text) ? ` · ${text}` : ''}`;
    const progress = !compact && info.total > 0 ? ` (${Math.min(info.current || 0, info.total)}/${info.total})` : '';
    return `${prefix}中${text ? ` · ${text}` : ''}${progress}`;
}

function refreshExtractionFloorStatus() {
    let status = null;
    try {
        status = getExtractionFloorStatus();
    } catch { return null; }

    const sidebar = document.getElementById('bb_sidebar_floor_status');
    if (sidebar) {
        sidebar.innerHTML = `<i class="fa-solid fa-layer-group"></i> 楼层状态：${escapeHtml(status.summary || '暂无可统计楼层')}`;
    }

    const hubLabel = document.getElementById('bb_hub_extract_label');
    const hubRow = document.getElementById('bb_hub_extract_progress');
    if (hubLabel && hubRow && !hubRow.dataset.busy) {
        hubLabel.textContent = formatHubIdleStatus(status);
    }
    return status;
}

function applyExtractedVisibilityClass(mode = getSettings().extractedMsgDisplay || 'hidden') {
    document.body.classList.remove('bb-show-extracted', 'bb-show-extracted-clear');
    if (mode === 'transparent') {
        document.body.classList.add('bb-show-extracted');
    } else if (mode === 'visible') {
        document.body.classList.add('bb-show-extracted-clear');
    }
}

function getExtensionFolder() {
    // 从 import.meta.url 解析扩展目录路径，不依赖 ST 核心模块的静态导入
    try {
        const url = String(import.meta.url);
        let m = url.match(/\/scripts\/extensions\/(.+?)\/index\.mjs(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/index\.js(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/[^/]+\.(?:js|mjs)(?:\?|[#]|$)/i);
        if (m?.[1]) return m[1];
    } catch { /* 忽略 */ }
    // 最终回退：假定为标准 third-party 安装路径
    return 'third-party/BB-Memory';
}

// ═══════════════════════════════════════════════════════════
//  初始化记忆（新功能）
// ═══════════════════════════════════════════════════════════

const SWITCH_EXTRACT_MODE = 'switch_latest';

function isRealSystemFloorMessage(msg) {
    return !!msg && msg.is_system === true && msg._bbmem_hideSource !== 'plugin';
}

function isManualAiFloorMessage(msg) {
    return !!msg && !msg.is_user && !isRealSystemFloorMessage(msg);
}

function findPreviousUserFloor(chat, aiIndex) {
    for (let j = aiIndex - 1; j >= 0; j--) {
        const msg = chat[j];
        if (msg?.is_user && String(msg.mes || '').trim()) {
            return { userIndex: j, userText: msg.mes || '' };
        }
    }
    return { userIndex: -1, userText: '' };
}

function getOpeningContextFloors(chat, userIndex) {
    if (userIndex <= 0) return [];
    const indices = [];
    for (let i = 0; i < userIndex; i++) {
        const msg = chat[i];
        if (!isManualAiFloorMessage(msg) || !String(msg.mes || '').trim()) continue;
        const prev = findPreviousUserFloor(chat, i);
        if (prev.userIndex === -1 && !msg._bbmem_extracted && !msg._bbmem_skipped && !msg._bbmem_meta_marker) {
            indices.push(i);
        }
    }
    return indices;
}

function isSwitchExtractableAiFloor(chat, aiIndex) {
    const msg = chat?.[aiIndex];
    if (!isManualAiFloorMessage(msg) || !String(msg.mes || '').trim()) return false;
    if (msg._bbmem_extracted || msg._bbmem_skipped || msg._bbmem_meta_marker) return false;
    const prev = findPreviousUserFloor(chat, aiIndex);
    if (prev.userIndex < 0) return false;
    const userMsg = chat[prev.userIndex];
    return !userMsg?._bbmem_skipped && !userMsg?._bbmem_meta_pair;
}

function buildSwitchFloorPlan(chat = []) {
    let latestAi = -1;
    const pending = [];
    const untreated = [];
    const candidates = [];

    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!isManualAiFloorMessage(msg)) continue;
        latestAi = i;
        if (msg._bbmem_pendingExtraction && !msg._bbmem_extracted && !msg._bbmem_meta_marker) pending.push(i);
        else if (!msg._bbmem_extracted && !msg._bbmem_skipped && !msg._bbmem_meta_marker) untreated.push(i);
        if (!isSwitchExtractableAiFloor(chat, i)) continue;

        const prev = findPreviousUserFloor(chat, i);
        const aiText = msg.mes || '';
        candidates.push({
            userIndex: prev.userIndex,
            aiIndex: i,
            userMessage: prev.userText,
            aiMessage: aiText,
            hash: computeExchangeHash(prev.userText, aiText),
        });
    }

    const first = candidates[0];
    const last = candidates[candidates.length - 1];
    if (first) {
        first.extraIndices = getOpeningContextFloors(chat, first.userIndex);
    }
    const start = first ? first.userIndex : -1;
    const end = last ? last.aiIndex : -1;
    return {
        latestAi,
        pending,
        untreated,
        candidates,
        start,
        end,
        range: start >= 0 && end >= start ? `${start}-${end}` : '',
    };
}

function formatFloorPreview(floors, emptyText, fromEnd = false) {
    if (!floors?.length) return emptyText;
    const list = fromEnd ? floors.slice(-12) : floors.slice(0, 12);
    return list.join(', ') + (floors.length > 12 ? ` 等${floors.length}层` : '');
}

function promptFloorRange() {
    return new Promise((resolve) => {
        const summary = getFloorRangeSummary();
        const overlay = document.createElement('div');
        overlay.className = 'bb-floor-select-overlay';
        const dialog = document.createElement('div');
        dialog.className = 'bb-mem-form-popup bb-floor-select-popup';
        dialog.innerHTML = `
            <div style="font-size:1.1em;font-weight:bold;margin-bottom:12px;color:var(--SmartThemeTextColor,#ddd);">
                <i class="fa-solid fa-layer-group"></i> 手动提取 — 选择楼层范围
            </div>
            <div style="font-size:0.8em;opacity:0.6;margin-bottom:10px;color:var(--SmartThemeTextColor,#ddd);">
                输入楼层范围（如 <b>0-10</b>），留空则提取最近 8 轮对话
            </div>
            <div style="font-size:0.78em;line-height:1.5;margin-bottom:10px;padding:8px 10px;border:1px solid var(--SmartThemeBorderColor,#444);border-radius:6px;background:rgba(255,255,255,0.04);color:var(--SmartThemeTextColor,#ddd);">
                ${summary.html}
            </div>
            <button id="bb_floor_switch_extract" class="menu_button bb-floor-switch-extract" ${summary.switchRange ? '' : 'disabled'}
                title="${summary.switchRange ? '从尚未提取的第一个 exchange 开始，逐层提取到最新可提取 AI 楼层' : '当前没有需要换楼提取的楼层'}">
                <i class="fa-solid fa-forward-fast"></i>
                ${summary.switchRange ? `换楼提取到最新（${summary.switchRange}）` : '换楼提取：暂无可补提楼层'}
            </button>
            <input id="bb_floor_range_input" type="text" placeholder="${summary.placeholder}"
                style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--SmartThemeBorderColor,#555);background:var(--SmartThemeInputColor,#1a1a2e);color:var(--SmartThemeTextColor,#ddd);font-size:0.95em;box-sizing:border-box;margin-bottom:14px;" />
            <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
                <button id="bb_floor_range_cancel" class="menu_button" style="opacity:0.6;">取消</button>
                <button id="bb_floor_range_ok" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">开始提取</button>
            </div>
        `;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const input = dialog.querySelector('#bb_floor_range_input');
        const okBtn = dialog.querySelector('#bb_floor_range_ok');
        const cancelBtn = dialog.querySelector('#bb_floor_range_cancel');
        const switchBtn = dialog.querySelector('#bb_floor_switch_extract');

        const cleanup = (value) => {
            overlay.remove();
            resolve(value);
        };

        okBtn.addEventListener('click', () => cleanup(input.value.trim()));
        switchBtn?.addEventListener('click', () => {
            if (!summary.switchRange) return;
            cleanup({ mode: SWITCH_EXTRACT_MODE, range: summary.switchRange });
        });
        cancelBtn.addEventListener('click', () => cleanup(null));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') cleanup(input.value.trim());
            if (e.key === 'Escape') cleanup(null);
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup(null);
        });
        setTimeout(() => input.focus(), 100);
    });
}

function getFloorRangeSummary() {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const plan = buildSwitchFloorPlan(chat);
        const latestAi = plan.latestAi;
        const start = latestAi >= 0 ? Math.max(0, latestAi - 15) : 0;
        const suggest = latestAi >= 0 ? `${start}-${latestAi}` : '';
        const pendingText = formatFloorPreview(plan.pending, '暂无已入队楼层');
        const untreatedText = formatFloorPreview(plan.untreated, '暂无明显未提取楼层', true);
        const switchText = plan.range
            ? `建议范围：<b>${plan.range}</b>，预计 ${plan.candidates.length} 个 exchange`
            : '暂无需要补提到最新的 AI 楼层';
        return {
            placeholder: suggest ? `建议 ${suggest}；留空=最近8轮` : '如 0-10（留空=最近8轮）',
            switchRange: plan.range,
            html: [
                `<div><i class="fa-solid fa-location-dot"></i> 最新 AI 楼层：<b>${latestAi >= 0 ? latestAi : '无'}</b>${suggest ? `，建议范围：<b>${suggest}</b>` : ''}</div>`,
                `<div><i class="fa-solid fa-forward-fast"></i> 换楼提取：${switchText}</div>`,
                `<div><i class="fa-solid fa-spinner"></i> 待提取楼层：${escapeHtml(pendingText)}</div>`,
                `<div><i class="fa-regular fa-circle"></i> 尚未提取楼层：${escapeHtml(untreatedText)}</div>`,
            ].join(''),
        };
    } catch {
        return { placeholder: '如 0-10（留空=最近8轮）', switchRange: '', html: '无法读取当前聊天楼层；可手动输入范围，留空使用最近 8 轮。' };
    }
}

async function toggleMetaMarkerForMessage(chat, aiIdx) {
    if (!chat?.[aiIdx]) return;
    const msg = chat[aiIdx];
    msg._bbmem_meta_marker = !msg._bbmem_meta_marker;
    let userText = '';
    let userIndex = -1;
    for (let j = aiIdx - 1; j >= 0; j--) {
        if (chat[j].is_user && chat[j].mes) { userText = chat[j].mes; userIndex = j; break; }
    }
    const hash = msg._bbmem_exchangeHash || computeExchangeHash(userText, msg.mes || '');

    if (!msg._bbmem_meta_marker) {
        setPluginHiddenState(msg, aiIdx, false);
        delete msg._bbmem_meta_pair;
        msg._bbmem_pendingExtraction = true;
        msg._bbmem_extracted = false;
        msg._bbmem_skipped = false;
        msg._bbmem_meta_reason = undefined;
        if (userIndex >= 0 && chat[userIndex]) {
            delete chat[userIndex]._bbmem_meta_pair;
            chat[userIndex]._bbmem_skipped = false;
            setPluginHiddenState(chat[userIndex], userIndex, false);
        }
        await unmarkExchangeProcessed(getChatId(), hash);
    } else {
        delete msg._bbmem_pendingExtraction;
        msg._bbmem_extracted = false;
        msg._bbmem_skipped = false;
        msg._bbmem_exchangeHash = hash;
        if (userIndex >= 0 && chat[userIndex]) {
            chat[userIndex]._bbmem_meta_pair = true;
            clearHitFrameMetadataLocal(chat[userIndex]);
        }
    }

    try { SillyTavern.getContext().saveChatDebounced?.(); } catch {}
    setTimeout(() => refreshExtractionMarkers(), 100);
    showToast(msg._bbmem_meta_marker ? '已标记为元对话：窗口内正常显示，进入提取窗口后跳过' : '已恢复为可提取楼层', 'info');
}

function normalizeManualExtractionRequest(input) {
    if (input && typeof input === 'object') {
        return {
            mode: input.mode || 'range',
            range: String(input.range || ''),
        };
    }
    return { mode: 'range', range: String(input || '') };
}

function parseManualFloorRange(rangeStr, chatLength) {
    if (!rangeStr || !String(rangeStr).includes('-') || chatLength <= 0) return null;
    const parts = String(rangeStr).split('-');
    const rawStart = parseInt(parts[0], 10);
    const rawEnd = parseInt(parts[1], 10);
    const a = Number.isFinite(rawStart) ? rawStart : 0;
    const b = Number.isFinite(rawEnd) ? rawEnd : chatLength - 1;
    const start = Math.max(0, Math.min(chatLength - 1, Math.min(a, b)));
    const end = Math.max(0, Math.min(chatLength - 1, Math.max(a, b)));
    return { start, end };
}

function formatManualChatMessage(msg, index = -1) {
    const role = msg?.is_user ? '用户' : (msg?.name || '角色');
    const floor = Number.isInteger(index) && index >= 0 ? ` ${index}楼` : '';
    return `${role}${floor}: ${msg?.mes || ''}`;
}

function buildManualBaseContext(ctx) {
    let contextText = '';

    try {
        if (ctx.characters && ctx.characterId !== undefined) {
            const char = ctx.characters[ctx.characterId];
            if (char) {
                contextText += `【角色卡】\n角色名：${char.name || ''}\n`;
                if (char.description) contextText += `描述：${char.description}\n`;
                if (char.personality) contextText += `性格：${char.personality}\n`;
                if (char.first_mes) contextText += `开场白：${char.first_mes}\n`;
                contextText += '\n';
            }
        }
    } catch { /* ignore */ }

    try {
        if (ctx.worldInfo && ctx.worldInfo.entries) {
            const entries = Object.values(ctx.worldInfo.entries);
            contextText += `【世界书】\n${entries.map(e => {
                const key = Array.isArray(e.key) ? e.key.join(',') : (e.key || '');
                return `${key}: ${e.content || ''}`;
            }).join('\n')}\n\n`;
        }
    } catch { /* ignore */ }

    return contextText;
}

function buildManualRangeContext(ctx, rangeStr = '') {
    let contextText = buildManualBaseContext(ctx);
    let sourceFloor = undefined;
    let range = null;
    let floors = [];
    try {
        const chat = ctx.chat || [];
        range = parseManualFloorRange(rangeStr, chat.length);
        let messagePairs;
        if (range) {
            messagePairs = chat
                .slice(range.start, range.end + 1)
                .map((msg, idx) => ({ msg, index: range.start + idx }))
                .filter(item => item.msg?.mes?.trim());
            sourceFloor = range.start; // 标记为范围起始楼层
        } else {
            messagePairs = chat
                .map((msg, index) => ({ msg, index }))
                .filter(item => item.msg?.mes?.trim())
                .slice(-8);
        }
        if (messagePairs.length) {
            floors = messagePairs.map(item => item.index).filter(Number.isInteger);
            contextText += `【最近对话】\n${messagePairs.map(item => formatManualChatMessage(item.msg, item.index)).join('\n')}`;
        }
    } catch { /* ignore */ }
    return { contextText, sourceInfo: typeof sourceFloor === 'number' ? { sourceFloor } : {}, floors, range };
}

function emptyExtractionResult() {
    return { npc: 0, items: 0, milestones: 0, timeline: 0, threads: 0, locations: 0, memories: 0 };
}

function mergeExtractionResult(total, next = {}) {
    for (const key of ['npc', 'items', 'milestones', 'timeline', 'threads', 'locations', 'memories']) {
        total[key] = (total[key] || 0) + (Number(next[key]) || 0);
    }
    return total;
}

function formatExtractionResultSummary(results = {}) {
    return `NPC ${results.npc || 0} / 物品 ${results.items || 0} / 里程碑 ${results.milestones || 0} / 时间线 ${results.timeline || 0} / 地点 ${results.locations || 0} / 记忆 ${results.memories || 0}`;
}

async function handleSwitchFloorExtraction(chatId, request = {}) {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    const plan = buildSwitchFloorPlan(chat);
    const requestedRange = parseManualFloorRange(request.range || plan.range, chat.length);
    const candidates = requestedRange
        ? plan.candidates.filter(ex => ex.aiIndex >= requestedRange.start && ex.aiIndex <= requestedRange.end)
        : plan.candidates;

    if (!candidates.length) {
        throw new Error('当前没有需要换楼提取的楼层');
    }

    const baseContext = buildManualBaseContext(ctx);
    const totals = emptyExtractionResult();
    const progressEl = createProgressToast(`换楼提取: 准备中（0/${candidates.length}）...`);
    const taskFloors = candidates.map(ex => ex.aiIndex);
    const taskId = beginExtractionProgress({
        mode: 'switch',
        floors: taskFloors,
        text: `准备换楼提取 ${candidates.length} 个 exchange...`,
    });
    let done = 0;

    try {
        for (let i = 0; i < candidates.length; i++) {
            const ex = candidates[i];
            const userMsg = chat[ex.userIndex];
            const aiMsg = chat[ex.aiIndex];
            const floorLabel = `${ex.userIndex}-${ex.aiIndex}`;
            const contextText = [
                baseContext,
                `【换楼提取】\n目标范围：${plan.range || floorLabel}\n当前处理：${floorLabel}楼\n`,
                '【最近对话】',
                ...(ex.extraIndices || []).map(idx => formatManualChatMessage(chat[idx], idx)),
                formatManualChatMessage(userMsg, ex.userIndex),
                formatManualChatMessage(aiMsg, ex.aiIndex),
            ].filter(Boolean).join('\n');

            const updateProgress = (info) => {
                if (progressEl) progressEl.textContent = `换楼提取: ${i + 1}/${candidates.length}（第 ${ex.aiIndex} 楼）${info.progress ? ` - ${info.progress}` : ''}`;
            };

            const results = await extractFromContext(chatId, contextText, {
                onProgress: updateProgress,
                taskId,
                mode: 'switch',
                floors: taskFloors,
                floor: ex.aiIndex,
                sourceInfo: {
                    sourceExchange: ex.hash,
                    sourceFloor: ex.aiIndex,
                    sourceChatId: chatId,
                    sourceMessageHash: cyrb53Hash(ex.aiMessage || ''),
                },
            });

            if (results?.failed) {
                throw new Error(`第 ${ex.aiIndex} 楼提取失败：${results.error || '未知错误'}`);
            }

            mergeExtractionResult(totals, results);
            await markExchangeExtracted(ex.userIndex, ex.aiIndex, ex.hash, ex.extraIndices || []);
            done++;
            if (progressEl) progressEl.textContent = `换楼提取: 已完成 ${done}/${candidates.length}（最新第 ${ex.aiIndex} 楼）`;
            refreshExtractionFloorStatus();
        }
    } catch (e) {
        failExtractionProgress(taskId, e, `换楼提取失败：${e.message || '未知错误'}（已完成 ${done}/${candidates.length}）`);
        if (progressEl) {
            progressEl.textContent = `换楼提取失败：${e.message || '未知错误'}（已完成 ${done}/${candidates.length}）`;
            setTimeout(() => progressEl.remove(), 5000);
        }
        throw e;
    }

    totals.switchFloors = done;
    totals.sourceRange = plan.range;
    completeExtractionProgress(taskId, totals, `换楼提取完成：${done} 个 exchange`);
    if (progressEl) {
        progressEl.textContent = `换楼提取完成！已处理 ${done} 个 exchange；${formatExtractionResultSummary(totals)}`;
        setTimeout(() => progressEl.remove(), 3000);
    }
    showToast(`换楼提取完成：已处理 ${done} 个 exchange；${formatExtractionResultSummary(totals)}`, 'success');
    return totals;
}

async function handleInitMemory(chatId, requestInput = '') {
    const request = normalizeManualExtractionRequest(requestInput);
    if (request.mode === SWITCH_EXTRACT_MODE) {
        return handleSwitchFloorExtraction(chatId, request);
    }

    const ctx = SillyTavern.getContext();
    const { contextText, sourceInfo, floors } = buildManualRangeContext(ctx, request.range);

    if (!contextText.trim()) {
        throw new Error('没有可用的上下文（角色卡、世界书、对话记录均为空）');
    }

    // 使用合并提取
    const progressEl = createProgressToast('手动提取: 准备中...');

    const updateProgress = (info) => {
        if (progressEl) progressEl.textContent = `手动提取: ${info.progress || ''}`;
    };

    const results = await extractFromContext(chatId, contextText, {
        onProgress: updateProgress,
        sourceInfo,
        mode: 'manual',
        floors,
    });
    if (results?.failed) {
        if (progressEl) {
            progressEl.textContent = `提取失败：${results.error || '未知错误'}`;
            setTimeout(() => progressEl.remove(), 5000);
        }
        throw new Error(results.error || 'AI 提取失败');
    }

    if (progressEl) {
        progressEl.textContent = `提取完成！${formatExtractionResultSummary(results)}`;
        setTimeout(() => progressEl.remove(), 3000);
    }

    showToast(`提取完成！${formatExtractionResultSummary(results)}`, 'success');
    return results;
}

// v8.2.3 暴露给 memory-manager.js 使用
globalThis.bbPromptFloorRange = promptFloorRange;
globalThis.bbHandleInitMemory = handleInitMemory;
// v9.3.3 供后台链上的实时记忆结算给出用户反馈
globalThis.bbShowToast = showToast;

function createProgressToast(text) {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.info === 'function') {
            const el = document.createElement('div');
            el.textContent = text;
            ctx.toastr.info(el, '', { timeOut: 0, extendedTimeOut: 0 });
            return el;
        }
    } catch { /* ignore */ }
    return null;
}

function showToast(msg, type = 'info') {
    if (shouldRecordToast(msg, type)) {
        recordActivity(type, type === 'error' ? '错误' : type === 'warning' ? '提醒' : type === 'success' ? '完成' : '通知', msg);
    }
    // v8.2.7 fallback: toastr 不可用时用 showTopNotification
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](msg, '', { timeOut: 3000 });
            return;
        }
    } catch { /* ignore */ }
    showTopNotification(msg, type);
}

function showExternalInitializerNotice() {
    const message = '请使用外置 html 转化工具进行记忆初始化';
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.Popup?.show?.text === 'function') {
            ctx.Popup.show.text('BB-Memory 初始化', message);
            return;
        }
        if (typeof ctx.Popup?.show?.alert === 'function') {
            ctx.Popup.show.alert('BB-Memory 初始化', message);
            return;
        }
    } catch { /* ignore */ }
    showToast(message, 'info');
}

// v8.0.0 顶部浮动通知（比 toastr 更显眼，用于重要操作反馈）
function showTopNotification(msg, type = 'info') {
    // 先尝试 toastr
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](msg, '', { timeOut: 3500 });
        }
    } catch { /* ignore */ }

    // 创建顶部浮动通知
    let container = document.getElementById('bb_notification_container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'bb_notification_container';
        container.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;display:flex;flex-direction:column;gap:8px;max-width:400px;width:90%;pointer-events:none;';
        document.body.appendChild(container);
    }

    const colors = { success: '#4caf50', error: '#f44336', info: '#2196f3', warning: '#ff9800' };
    const notif = document.createElement('div');
    notif.style.cssText = `background:${colors[type] || colors.info};color:#fff;padding:12px 18px;border-radius:8px;font-size:0.92em;box-shadow:0 4px 16px rgba(0,0,0,0.35);animation:bbNotifIn 0.35s ease;text-align:center;pointer-events:auto;font-weight:500;`;
    notif.textContent = msg;

    container.appendChild(notif);

    setTimeout(() => {
        notif.style.opacity = '0';
        notif.style.transform = 'translateY(-10px)';
        notif.style.transition = 'opacity 0.3s, transform 0.3s';
        setTimeout(() => { notif.remove(); }, 300);
    }, 3500);
}

// v8.1.0 错误弹窗（提取/向量化失败时显示详细信息）
function showErrorPopup(title, message, details = '') {
    recordActivity('error', title || '错误', message || '未知错误', details);
    // 同时 toast
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.error === 'function') {
            ctx.toastr.error(title + ': ' + message, '', { timeOut: 5000 });
        }
    } catch { /* ignore */ }

    // 弹窗
    const overlay = document.createElement('div');
    overlay.className = 'bb-error-popup-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const dialog = document.createElement('div');
    dialog.className = 'bb-error-popup-dialog';
    dialog.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
            <i class="fa-solid fa-circle-exclamation" style="color:#f44336;font-size:1.3em;"></i>
            <span style="font-weight:bold;font-size:1.05em;color:#f44336;">${escapeHtml(title)}</span>
        </div>
        <div style="font-size:0.9em;margin-bottom:6px;color:var(--SmartThemeBodyColor,#ddd);">${escapeHtml(message)}</div>
        ${details ? `<div style="font-size:0.78em;opacity:0.6;margin-bottom:6px;word-break:break-all;max-height:80px;overflow-y:auto;background:rgba(0,0,0,0.2);padding:8px;border-radius:6px;">${escapeHtml(details)}</div>` : ''}
        <div style="font-size:0.75em;opacity:0.4;margin-bottom:12px;">请检查相关 API 配置后重试</div>
        <button class="menu_button" style="width:100%;">关闭</button>
    `;
    dialog.querySelector('button').addEventListener('click', () => overlay.remove());

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// 全局暴露，供 auto-generator.js 调用
globalThis.bbShowErrorPopup = showErrorPopup;
globalThis.bbMemoryShowToast = showToast;

// ═══════════════════════════════════════════════════════════
//  设置面板绑定
// ═══════════════════════════════════════════════════════════

function pickExtensionsSettingsContainer() {
    return document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings')
        || document.querySelector('#extensionsPane #extensions_settings2')
        || document.querySelector('#extensionsPane #extensions_settings');
}

async function mountExtensionSettingsHtml(html, maxAttempts = 50, delayMs = 100) {
    for (let i = 0; i < maxAttempts; i++) {
        const container = pickExtensionsSettingsContainer();
        if (container) {
            container.insertAdjacentHTML('beforeend', html);
            return true;
        }
        await new Promise(r => setTimeout(r, delayMs));
    }
    console.error('[BB-Memory] 未找到扩展设置容器 (#extensions_settings / #extensions_settings2)，无法在酒馆界面显示设置');
    return false;
}

function reorderSettingsSections() {
    const root = document.querySelector('#bb_memory_root .inline-drawer-content');
    if (!root) return;
    const order = [
        'hits',
        'autogen',
        'embedding',
        'injection',
        'tier',
        'healthcheck',
        'calendar',
        'custom',
        'experimental',
    ];
    const sections = new Map();
    root.querySelectorAll('.bb-settings-section-header[data-section]').forEach(header => {
        const section = header.closest('.bb-settings-section');
        if (section) sections.set(header.dataset.section, section);
    });
    const anchor = document.querySelector('#bb_auto_backup_status') || root.querySelector('.bb-mem-sidebar-info:last-of-type');
    if (!anchor) return;

    let insertAfter = anchor;
    for (const key of order) {
        const section = sections.get(key);
        if (!section) continue;
        const prev = section.previousElementSibling;
        const separator = prev?.tagName === 'HR' ? prev : document.createElement('hr');
        if (prev?.tagName !== 'HR') separator.dataset.bbGenerated = '1';

        insertAfter.after(separator);
        separator.after(section);
        insertAfter = section;
    }
}

function restoreApiSettings(settings) {
    const fields = {
        '#bb_auto_gen_endpoint': 'autoGenEndpoint',
        '#bb_auto_gen_api_key': 'autoGenApiKey',
        '#bb_auto_gen_model': 'autoGenModel',
        '#bb_embedding_endpoint': 'embeddingEndpoint',
        '#bb_embedding_api_key': 'embeddingApiKey',
        '#bb_embedding_model': 'embeddingModel',
    };
    for (const [sel, key] of Object.entries(fields)) {
        const el = document.querySelector(sel);
        if (el) el.value = settings[key] || '';
    }
}

function bindSidebarEvents() {
    const settings = getSettings();

    // 基础开关
    bindCheckbox('#bb_memory_enabled', 'enabled');
    bindCheckbox('#bb_auto_gen_enabled', 'autoGenEnabled', (checked) => {
        if (checked) initAutoGenerator(); else stopAutoGenerator();
    });
    bindCheckbox('#bb_embedding_enabled', 'embeddingEnabled');
    bindCheckbox('#bb_dedup_enabled', 'dedupEnabled');
    bindCheckbox('#bb_entity_dedup_enabled', 'entityDedupEnabled');
    bindCheckbox('#bb_debug_logging', 'debugLogging');
    bindCheckbox('#bb_timeline_summary_enabled', 'timelineSummaryEnabled');
    bindCheckbox('#bb_clue_board_injection_enabled', 'clueBoardInjectionEnabled');
    bindCheckbox('#bb_auto_backup_enabled', 'autoBackupEnabled');

    // v7.9.0 自动备份状态指示器
    const updateAutoBackupStatus = () => {
        const el = document.querySelector('#bb_auto_backup_status');
        if (!el) return;
        const enabled = getSettings().autoBackupEnabled;
        el.innerHTML = enabled
            ? '<i class="fa-solid fa-circle" style="color:#4caf50;"></i> 自动备份已开启（30秒防抖，超限会跳过）'
            : '<i class="fa-solid fa-circle" style="color:#ff9800;"></i> 自动备份已关闭';
    };
    document.querySelector('#bb_auto_backup_enabled')?.addEventListener('change', updateAutoBackupStatus);
    updateAutoBackupStatus();

    // 选择器
    bindSelect('#bb_auto_gen_mode', 'autoGenMode');
    bindSelect('#bb_extraction_confirm_mode', 'extractionConfirmMode');
    bindSelect('#bb_active_confirm_style', 'activeConfirmStyle');

    // v7.7.1 提取模式固定为合并提取，移除 extractionMode 选择器

    // 提取风格
    bindSelect('#bb_extraction_style', 'extractionStyle');
    bindSelect('#bb_dedup_ambiguous_action', 'dedupAmbiguousAction');
    const styleSelect = document.querySelector('#bb_extraction_style');
    const customBiasSection = document.querySelector('#bb_custom_bias_section');
    const customBiasTextarea = document.querySelector('#bb_custom_extraction_bias');

    // 自定义偏置区域显示/隐藏
    const toggleCustomBias = () => {
        if (styleSelect && customBiasSection) {
            customBiasSection.style.display = styleSelect.value === 'custom' ? '' : 'none';
        }
    };
    if (styleSelect) {
        styleSelect.addEventListener('change', toggleCustomBias);
        toggleCustomBias(); // 初始状态
    }

    // 自定义偏置文本绑定（手动处理）
    if (customBiasTextarea) {
        customBiasTextarea.value = getSettings().customExtractionBias || '';
        customBiasTextarea.addEventListener('change', () => {
            updateSettings({ customExtractionBias: customBiasTextarea.value });
        });
    }

    // v7.7.1 自定义提示词绑定
    bindExtractionTagControls();
    renderPromptTemplateList(settings);

    document.querySelector('#bb_export_extract_settings_btn')?.addEventListener('click', () => {
        try {
            const payload = buildSettingsExportPayload();
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            downloadTextFile(`bb-memory-settings-v${SETTINGS_EXPORT_VERSION}-${stamp}.json`, JSON.stringify(payload, null, 2));
            showToast('设置与提示词模板已导出（不含 API Key）', 'success');
        } catch (e) {
            showToast(`设置导出失败: ${e.message}`, 'error');
        }
    });

    const importSettingsInput = document.querySelector('#bb_import_extract_settings_file');
    document.querySelector('#bb_import_extract_settings_btn')?.addEventListener('click', () => {
        importSettingsInput?.click();
    });
    importSettingsInput?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = '';
        if (!file) return;
        try {
            const text = await file.text();
            const payload = JSON.parse(text);
            const patch = normalizeImportedSettingsPayload(payload);
            updateSettings(patch);
            syncSettingsControls(getSettings());
            restoreApiSettings(getSettings());
            refreshProfileDropdown?.();
            refreshEmbeddingProfileDropdown?.();
            if (patch.autoGenEnabled !== undefined) {
                if (getSettings().autoGenEnabled) initAutoGenerator(); else stopAutoGenerator();
            }
            const promptCount = Object.keys(patch.customPromptTemplates || {}).length;
            const promptText = promptCount ? `，提示词模板 ${promptCount} 项` : '';
            showToast(`设置导入完成：${Object.keys(patch).length} 项已更新${promptText}（API Key 保持本机现有值）`, 'success');
        } catch (e) {
            showToast(`设置导入失败: ${e.message}`, 'error');
        }
    });

    // 数字/文本输入
    bindInput('#bb_context_window', 'contextWindowExchanges', 'number');
    bindInput('#bb_batch_extraction', 'batchExtractionCount', 'number');
    bindInput('#bb_max_memories_per_exchange', 'maxMemoriesPerExchange', 'number');
    bindInput('#bb_source_rollback_floor_window', 'sourceRollbackFloorWindow', 'number');
    bindInput('#bb_token_budget', 'tokenBudget', 'number');
    bindSelect('#bb_token_budget_mode', 'tokenBudgetMode');
    bindInput('#bb_max_results', 'maxResults', 'number');
    bindInput('#bb_min_score_threshold', 'minScoreThreshold', 'number');
    bindInput('#bb_floor_recent_window', 'floorRecentWindow', 'number');
    bindInput('#bb_npc_injection_max', 'npcInjectionMax', 'number');
    bindInput('#bb_item_injection_max', 'itemInjectionMax', 'number');
    bindInput('#bb_milestone_vector_max', 'milestoneVectorMax', 'number');
    bindSelect('#bb_milestone_default_injection_mode', 'milestoneDefaultInjectionMode');
    bindInput('#bb_map_injection_max', 'mapInjectionMax', 'number');
    bindInput('#bb_maintenance_mem_threshold', 'maintenanceMemThreshold', 'number');
    bindInput('#bb_maintenance_npc_threshold', 'maintenanceNpcThreshold', 'number');
    bindInput('#bb_maintenance_item_threshold', 'maintenanceItemThreshold', 'number');
    bindInput('#bb_item_dusty_miss_rounds', 'itemDustyMissRounds', 'number');
    bindSelect('#bb_maintenance_mode', 'maintenanceMode');
    bindInput('#bb_diversity_limit', 'diversityLimitPerTag', 'number');
    bindInput('#bb_promotion_cooldown_rounds', 'promotionCooldownRounds', 'number');
    bindInput('#bb_hit_score_promote_threshold', 'hitScorePromoteThreshold', 'number');
    bindInput('#bb_hit_score_eternal_threshold', 'hitScoreEternalThreshold', 'number');
    bindInput('#bb_hit_score_demote_threshold', 'hitScoreDemoteThreshold', 'number');
    bindInput('#bb_entity_tier_promote_threshold', 'entityTierPromoteThreshold', 'number');
    bindInput('#bb_entity_tier_demote_threshold', 'entityTierDemoteThreshold', 'number');
    bindInput('#bb_max_active_timeline', 'maxActiveTimeline', 'number');
    bindInput('#bb_chat_metadata_backup_max_kb', 'chatMetadataBackupMaxKb', 'number');
    bindInput('#bb_cloud_vector_slot_max_kb', 'cloudVectorSlotMaxKb', 'number');
    bindInput('#bb_health_check_duplicate_threshold', 'healthCheckDuplicateThreshold', 'number');
    bindInput('#bb_health_check_isolation_threshold', 'healthCheckIsolationThreshold', 'number');
    bindInput('#bb_health_check_stale_days', 'healthCheckStaleDays', 'number');
    bindInput('#bb_health_check_stale_hit_threshold', 'healthCheckStaleHitThreshold', 'number');
    bindInput('#bb_health_check_thread_stale_days', 'healthCheckThreadStaleDays', 'number');
    bindInput('#bb_health_check_clue_stale_days', 'healthCheckClueStaleDays', 'number');
    // v9.3.3 AI 记忆整理
    bindCheckbox('#bb_ai_curate_enabled', 'aiCurateEnabled', refreshCurateStatus);
    bindSelect('#bb_ai_curate_trigger_mode', 'aiCurateTriggerMode');
    document.querySelector('#bb_ai_curate_trigger_mode')?.addEventListener('change', refreshCurateStatus);
    bindInput('#bb_ai_curate_mem_threshold', 'aiCurateMemThreshold', 'number');
    bindInput('#bb_ai_curate_npc_threshold', 'aiCurateNpcThreshold', 'number');
    bindInput('#bb_ai_curate_item_threshold', 'aiCurateItemThreshold', 'number');
    bindInput('#bb_ai_curate_milestone_threshold', 'aiCurateMilestoneThreshold', 'number');
    bindInput('#bb_ai_curate_timeline_threshold', 'aiCurateTimelineThreshold', 'number');
    bindInput('#bb_ai_curate_cluster_threshold', 'aiCurateClusterThreshold', 'number');
    bindInput('#bb_ai_curate_recall_per_entry', 'aiCurateRecallPerEntry', 'number');
    bindInput('#bb_ai_curate_max_groups', 'aiCurateMaxGroupsPerRun', 'number');
    bindSelect('#bb_ai_curate_auth_merge', 'aiCurateAuthMerge');
    bindSelect('#bb_ai_curate_auth_rewrite', 'aiCurateAuthRewrite');
    bindSelect('#bb_ai_curate_auth_split', 'aiCurateAuthSplit');
    bindSelect('#bb_ai_curate_auth_delete', 'aiCurateAuthDelete');
    bindInput('#bb_ai_curate_undo_depth', 'aiCurateUndoDepth', 'number');
    bindSelect('#bb_dedup_time_conflict_scope', 'dedupTimeConflictScope');
    // v9.3.3 实时记忆（第五柱）
    bindCheckbox('#bb_realtime_enabled', 'realtimeEnabled', refreshRealtimeStatus);
    bindCheckbox('#bb_realtime_extract_enabled', 'realtimeExtractEnabled');
    bindSelect('#bb_realtime_extract_scope', 'realtimeExtractScope');
    bindInput('#bb_realtime_extract_first_n', 'realtimeExtractFirstN', 'number');
    bindInput('#bb_realtime_max_details_per_floor', 'realtimeMaxDetailsPerFloor', 'number');
    bindInput('#bb_realtime_ttl_floors', 'realtimeTtlFloors', 'number');
    bindInput('#bb_realtime_max_entries', 'realtimeMaxEntries', 'number');
    bindCheckbox('#bb_realtime_scene_change_settle', 'realtimeSceneChangeSettle');
    bindInput('#bb_realtime_injection_max', 'realtimeInjectionMax', 'number');
    bindInput('#bb_realtime_injection_token_cap', 'realtimeInjectionTokenCap', 'number');
    bindSelect('#bb_realtime_promotion_mode', 'realtimePromotionMode');
    bindSelect('#bb_realtime_settle_mode', 'realtimeSettleMode');
    // 注入上限改了立刻刷新状态行里的注入预览
    for (const sel of ['#bb_realtime_injection_max', '#bb_realtime_injection_token_cap']) {
        document.querySelector(sel)?.addEventListener('change', refreshRealtimeStatus);
    }
    // 阈值变了立刻刷新进度提示，避免显示旧分母
    for (const sel of ['#bb_ai_curate_mem_threshold', '#bb_ai_curate_npc_threshold', '#bb_ai_curate_item_threshold',
        '#bb_ai_curate_milestone_threshold', '#bb_ai_curate_timeline_threshold']) {
        document.querySelector(sel)?.addEventListener('change', refreshCurateStatus);
    }
    bindInput('#bb_injection_template', 'injectionTemplate', 'string');
    // API 配置字段绑定
    bindInput('#bb_auto_gen_endpoint', 'autoGenEndpoint', 'string');
    bindInput('#bb_auto_gen_api_key', 'autoGenApiKey', 'string');
    bindInput('#bb_auto_gen_model', 'autoGenModel', 'string');
    bindInput('#bb_embedding_endpoint', 'embeddingEndpoint', 'string');
    bindInput('#bb_embedding_api_key', 'embeddingApiKey', 'string');
    bindInput('#bb_embedding_model', 'embeddingModel', 'string');
    bindInput('#bb_merge_similarity_threshold', 'mergeSimilarityThreshold', 'number');
    bindInput('#bb_reduce_similarity_threshold', 'reduceSimilarityThreshold', 'number');
    bindInput('#bb_entity_merge_similarity_threshold', 'entityMergeSimilarityThreshold', 'number');
    bindInput('#bb_dedup_review_similarity_threshold', 'dedupReviewSimilarityThreshold', 'number');
    bindInput('#bb_dedup_known_entity_limit', 'dedupKnownEntityLimit', 'number');
    // v7.8.0 日历描述改为 per-chat 存储
    const calTextarea = document.querySelector('#bb_calendar_description');
    if (calTextarea) {
        // 加载当前聊天的日历
        (async () => {
            const chatId = getChatId();
            if (chatId) {
                const val = await getCalendarDescription(chatId);
                calTextarea.value = val || '';
            }
        })();
        calTextarea.addEventListener('change', async () => {
            const chatId = getChatId();
            if (chatId) await setCalendarDescription(chatId, calTextarea.value);
        });
    }

    // 按钮
    document.querySelector('#bb_memory_backup_now')?.addEventListener('click', async function () {
        const chatId = getChatId();
        if (!chatId) return;
        const origHTML = this.innerHTML;
        this.disabled = true;
        this.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 备份中...';
        try {
            const result = await exportMemoriesToChatMetadata(chatId);
            if (result.skipped) {
                showToast(`备份已跳过：${(result.size / 1024).toFixed(1)}KB 超过上限 ${(result.limit / 1024).toFixed(0)}KB，请提高上限或使用本地 JSON 导出`, 'warning');
            } else {
                showToast(`备份完成：${result.count} 条文本/引用 (${(result.size / 1024).toFixed(1)}KB) → 已保存到服务器；向量请在存档页使用云端向量槽同步`, 'success');
            }
        } catch (e) {
            showToast(`备份失败: ${e.message}`, 'error');
        } finally {
            this.disabled = false;
            this.innerHTML = origHTML;
        }
    });
    document.querySelector('#bb_memory_restore_now')?.addEventListener('click', async function () {
        const chatId = getChatId();
        if (!chatId) return;
        const origHTML = this.innerHTML;
        this.disabled = true;
        this.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 恢复中...';
        try {
            const result = await importMemoriesFromChatMetadata(chatId);
            if (result.restored === 0 && result.skipped === 0) {
                showToast('暂无备份数据可恢复', 'info');
            } else {
                const vectorTip = result.vectorImported ? `，恢复向量 ${result.vectorImported} 条` : '';
                showToast(`恢复完成：${result.restored} 条新增，${result.skipped} 条跳过${vectorTip}`, 'success');
            }
        } catch (e) {
            showToast(`恢复失败: ${e.message}`, 'error');
        } finally {
            this.disabled = false;
            this.innerHTML = origHTML;
        }
    });
    document.querySelector('#bb_init_memory_btn')?.addEventListener('click', async () => {
        showExternalInitializerNotice();
    });

    // v5.5: 记忆管家 → 完整管理器
    document.querySelector('#bb_memory_manage_btn')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        openMemoryManager(chatId);
    });

    document.querySelector('#bb_memory_help_btn')?.addEventListener('click', () => {
        const url = new URL('./BBMemory使用说明.html', import.meta.url).href;
        const opened = window.open(url, '_blank', 'noopener');
        if (opened) showToast('已打开 BB-Memory 使用说明', 'info');
        else showToast('浏览器阻止了说明页弹窗，可手动打开扩展目录中的 BBMemory使用说明.html', 'warning');
    });

    // v5.5: 记忆维护
    document.querySelector('#bb_memory_extract_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const range = await promptFloorRange();
        if (range === null) return; // 用户取消
        showToast('正在收集上下文并提取记忆...', 'info');
        try {
            await handleInitMemory(chatId, range);
            refreshSidebar();
        } catch (e) {
            showToast(`提取失败: ${e.message}`, 'error');
        }
    });

    // v5.3: 标记消息
    document.querySelector('#bb_memory_meta_btn')?.addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat || chat.length < 2) { showToast('聊天消息不足', 'warning'); return; }
        let aiIdx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && !chat[i].is_system) { aiIdx = i; break; }
        }
        if (aiIdx === -1) { showToast('未找到 AI 消息', 'warning'); return; }
        await toggleMetaMarkerForMessage(chat, aiIdx);
    });
    document.querySelector('#bb_memory_toggle_vis_btn')?.addEventListener('click', () => {
        cycleExtractedVisibility();
    });

    // v5.5: 记忆维护按钮
    document.querySelector('#bb_memory_maintenance_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        try {
            const result = await checkMaintenanceNeeded(chatId);
            showMaintenancePopup(chatId, result);
        } catch (e) {
            console.warn('[BB-Memory] 维护检查异常:', e.message);
            showToast('维护检查出错: ' + e.message, 'error');
            // 仍然打开面板（空数据模式）
            showMaintenancePopup(chatId, { issues: [], issueCount: 0, totalItems: 0, needed: false });
        }
    });
    // v9.2.0 刷新时间线总结
    document.querySelector('#bb_thread_refresh_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        showToast('正在生成时间线总结...', 'info');
        try {
            const result = await regenerateThreadSummary(chatId);
            if (result.threadCount > 0) {
                showToast(`时间线总结完成：${result.timelineCount || result.threadCount} 条时间线`, 'success');
            } else {
                showToast('时间线总结完成：本轮无需更新', 'info');
            }
        } catch (e) {
            console.warn('[BB-Memory] 时间线总结失败:', e.message);
            showToast('时间线总结失败: ' + e.message, 'error');
        }
    });
    // v7.9.0 换楼刷新（从悬浮窗移到侧边栏）
    document.querySelector('#bb_floor_refresh_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const stats = await refreshAllSourceFloors(chatId);
        const total = stats.npc + stats.items + stats.timeline + stats.memories;
        if (total === 0) {
            showToast('当前没有需要刷新的楼层记忆', 'info');
        } else {
            showToast(`已标记 ${total} 条记忆为旧聊天来源（NPC:${stats.npc} 物品:${stats.items} 里程碑:${stats.milestones || stats.timeline} 记忆:${stats.memories}）`, 'success');
        }
    });
    document.querySelector('#bb_clue_board_btn')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        import('./clue-board.js').then(m => m.openClueBoard(chatId));
    });
    document.querySelector('#bb_map_btn')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        import('./map-view.js').then(m => m.openMapView(chatId));
    });
    document.querySelector('#bb_slot_rescue_btn')?.addEventListener('click', () => {
        openSlotRescuePanel().catch(e => showToast(`打开存档救援失败: ${e.message}`, 'error'));
    });
    // v9.3.3 AI 记忆整理
    document.querySelector('#bb_curate_now_btn')?.addEventListener('click', () => handleCurateNow(false));
    document.querySelector('#bb_curate_full_btn')?.addEventListener('click', () => handleCurateNow(true));
    document.querySelector('#bb_curate_undo_btn')?.addEventListener('click', handleCurateUndo);
    refreshCurateStatus();
    // v9.3.3 实时记忆（第五柱）
    document.querySelector('#bb_realtime_settle_btn')?.addEventListener('click', handleRealtimeSettle);
    document.querySelector('#bb_realtime_undo_btn')?.addEventListener('click', handleRealtimeUndo);
    refreshRealtimeStatus();
    document.querySelector('#bb_agent_btn')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        showToast('正在打开 Agent 测试版；实验功能可能执行写操作，建议先备份。', 'warning');
        import('./memory-agent.js').then(m => m.openAgent(chatId));
    });

    document.querySelector('#bb_embedding_reindex_btn')?.addEventListener('click', async () => {
        const btn = document.querySelector('#bb_embedding_reindex_btn');
        const origHTML = btn?.innerHTML;
        const chatId = getChatId();
        if (!chatId) return;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 重建中...'; }
        try {
            const [npc, items, milestones, memories, timeline, mapData] = await Promise.all([
                getNpcProfiles(chatId),
                getItems(chatId),
                getMilestones(chatId),
                getMemories(chatId),
                getTimeline(chatId),
                getMap(chatId),
            ]);
            const collections = [
                { key: 'npc', label: 'NPC', entries: npc },
                { key: 'item', label: '物品', entries: items },
                { key: 'milestone', label: '里程碑', entries: milestones },
                { key: 'mem', label: '记忆', entries: memories },
                { key: 'timeline', label: '时间线', entries: timeline },
                { key: 'map', label: '地图', entries: Object.values(mapData?.locations || {}) },
            ];
            const totalResult = { total: 0, updated: 0, failed: 0 };
            for (const group of collections) {
                const result = await embedExistingMemories(chatId, group.entries, (done, total) => {
                    if (done % 10 === 0) console.log(`[BB-Memory] Reindex ${group.label}: ${done}/${total}`);
                }, group.key);
                totalResult.total += result.total;
                totalResult.updated += result.updated;
                totalResult.failed += result.failed;
            }
            showToast(`Reindex 完成：检查 ${totalResult.total} 条，更新 ${totalResult.updated} 条，失败 ${totalResult.failed} 条`, totalResult.failed ? 'warning' : 'success');
        } catch (e) {
            showToast(`Reindex 失败: ${e.message}`, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
        }
    });

    // ═══ v8.2.3 API 测试连接 ═══

    document.querySelector('#bb_api_test_connection')?.addEventListener('click', async () => {
        const btn = document.querySelector('#bb_api_test_connection');
        const origHTML = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中...';
        try {
            const ep = document.querySelector('#bb_auto_gen_endpoint')?.value?.trim();
            const key = document.querySelector('#bb_auto_gen_api_key')?.value?.trim();
            const model = document.querySelector('#bb_auto_gen_model')?.value?.trim();
            if (!ep) { showToast('请先填写 API 端点', 'warning'); return; }
            const result = await testApiConnection(ep, key, model);
            if (result.ok) {
                showToast(`连接成功！延迟 ${result.latency}ms`, 'success');
            } else {
                showToast(`连接失败: ${result.error} (${result.latency}ms)`, 'error');
            }
        } catch (e) {
            showToast(`测试异常: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = origHTML;
        }
    });

    document.querySelector('#bb_embedding_test_btn')?.addEventListener('click', async () => {
        const btn = document.querySelector('#bb_embedding_test_btn');
        const origHTML = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中...';
        try {
            const ep = document.querySelector('#bb_embedding_endpoint')?.value?.trim();
            const key = document.querySelector('#bb_embedding_api_key')?.value?.trim();
            const model = document.querySelector('#bb_embedding_model')?.value?.trim();
            if (!ep) { showToast('请先填写 Embedding API 端点', 'warning'); return; }
            updateSettings({ embeddingEndpoint: ep, embeddingApiKey: key, embeddingModel: model });
            const start = Date.now();
            const embedding = await callEmbeddingApi('test', 15000);
            const latency = Date.now() - start;
            showToast(`连接成功！延迟 ${latency}ms，维度 ${embedding.length}`, 'success');
        } catch (e) {
            showToast(`测试异常: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = origHTML;
        }
    });

    // ═══ v8.2.3 API 预设管理 ═══

    const profileSelect = document.querySelector('#bb_api_profile_select');
    const refreshProfileDropdown = () => {
        if (!profileSelect) return;
        const s = getSettings();
        const profiles = s.apiProfiles || [];
        profileSelect.innerHTML = '<option value="">-- 未选择 --</option>' +
            profiles.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
        if (s.activeApiProfile && profiles.some(p => p.name === s.activeApiProfile)) {
            const idx = profiles.findIndex(p => p.name === s.activeApiProfile);
            profileSelect.value = String(idx);
        }
    };

    profileSelect?.addEventListener('change', () => {
        const idx = profileSelect.value;
        if (idx === '') return;
        const s = getSettings();
        const p = s.apiProfiles?.[parseInt(idx)];
        if (!p) return;
        const epEl = document.querySelector('#bb_auto_gen_endpoint');
        const keyEl = document.querySelector('#bb_auto_gen_api_key');
        const modelEl = document.querySelector('#bb_auto_gen_model');
        if (epEl) epEl.value = p.endpoint || '';
        if (keyEl) keyEl.value = p.key || '';
        if (modelEl) modelEl.value = p.model || '';
        // v8.2.5 修复：bindInput 监听的是 change 事件，必须用 change 而非 input
        if (epEl) epEl.dispatchEvent(new Event('change', { bubbles: true }));
        if (keyEl) keyEl.dispatchEvent(new Event('change', { bubbles: true }));
        if (modelEl) modelEl.dispatchEvent(new Event('change', { bubbles: true }));
        // v8.2.7 Embedding API 预设同步 —— 旧预设无字段时清空输入框
        const embEpEl = document.querySelector('#bb_embedding_endpoint');
        const embKeyEl = document.querySelector('#bb_embedding_api_key');
        const embModelEl = document.querySelector('#bb_embedding_model');
        if (embEpEl) { embEpEl.value = p.embeddingEndpoint || ''; embEpEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (embKeyEl) { embKeyEl.value = p.embeddingKey || ''; embKeyEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (embModelEl) { embModelEl.value = p.embeddingModel || ''; embModelEl.dispatchEvent(new Event('change', { bubbles: true })); }
        updateSettings({ activeApiProfile: p.name });
        showToast(`已切换至预设: ${p.name}`, 'info');
        // v8.2.7 同步 Embedding 预设下拉框
        refreshEmbeddingProfileDropdown();
    });

    // v8.2.7 Embedding 预设下拉框 —— 与 AI 预设共享数据源
    const embProfileSelect = document.querySelector('#bb_embedding_profile_select');
    function refreshEmbeddingProfileDropdown() {
        if (!embProfileSelect) return;
        const s = getSettings();
        const profiles = s.apiProfiles || [];
        embProfileSelect.innerHTML = '<option value="">-- 未选择 --</option>' +
            profiles.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
    };

    embProfileSelect?.addEventListener('change', () => {
        const idx = embProfileSelect.value;
        if (idx === '') return;
        const s = getSettings();
        const p = s.apiProfiles?.[parseInt(idx)];
        if (!p) return;
        const epEl = document.querySelector('#bb_auto_gen_endpoint');
        const keyEl = document.querySelector('#bb_auto_gen_api_key');
        const modelEl = document.querySelector('#bb_auto_gen_model');
        if (epEl) { epEl.value = p.endpoint || ''; epEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (keyEl) { keyEl.value = p.key || ''; keyEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (modelEl) { modelEl.value = p.model || ''; modelEl.dispatchEvent(new Event('change', { bubbles: true })); }
        const embEpEl = document.querySelector('#bb_embedding_endpoint');
        const embKeyEl = document.querySelector('#bb_embedding_api_key');
        const embModelEl = document.querySelector('#bb_embedding_model');
        if (embEpEl) { embEpEl.value = p.embeddingEndpoint || ''; embEpEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (embKeyEl) { embKeyEl.value = p.embeddingKey || ''; embKeyEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (embModelEl) { embModelEl.value = p.embeddingModel || ''; embModelEl.dispatchEvent(new Event('change', { bubbles: true })); }
        updateSettings({ activeApiProfile: p.name });
        refreshProfileDropdown();
        showToast(`已切换至预设: ${p.name}`, 'info');
    });

    document.querySelector('#bb_api_profile_save')?.addEventListener('click', async () => {
        const name = prompt('请输入预设名称：');
        if (!name || !name.trim()) return;
        const ep = document.querySelector('#bb_auto_gen_endpoint')?.value?.trim() || '';
        const key = document.querySelector('#bb_auto_gen_api_key')?.value?.trim() || '';
        const model = document.querySelector('#bb_auto_gen_model')?.value?.trim() || '';
        // v8.2.5 Embedding API 也纳入预设
        const embEp = document.querySelector('#bb_embedding_endpoint')?.value?.trim() || '';
        const embKey = document.querySelector('#bb_embedding_api_key')?.value?.trim() || '';
        const embModel = document.querySelector('#bb_embedding_model')?.value?.trim() || '';
        if (!ep) { showToast('请先填写 API 端点', 'warning'); return; }

        const s = getSettings();
        const profiles = s.apiProfiles || [];
        const existing = profiles.findIndex(p => p.name === name.trim());
        const entry = { name: name.trim(), endpoint: ep, key, model, embeddingEndpoint: embEp, embeddingKey: embKey, embeddingModel: embModel };
        if (existing >= 0) {
            profiles[existing] = entry;
        } else {
            profiles.push(entry);
        }
        updateSettings({ apiProfiles: profiles, activeApiProfile: name.trim() });
        refreshProfileDropdown();
        refreshEmbeddingProfileDropdown();
        showToast(`预设"${name.trim()}"已保存`, 'success');
    });

    document.querySelector('#bb_api_profile_del')?.addEventListener('click', () => {
        const idx = profileSelect?.value;
        if (idx === '' || idx === null) { showToast('请先选择要删除的预设', 'warning'); return; }
        const s = getSettings();
        const profiles = s.apiProfiles || [];
        const p = profiles[parseInt(idx)];
        if (!p) return;
        if (!confirm(`确定删除预设"${p.name}"？`)) return;
        profiles.splice(parseInt(idx), 1);
        const newActive = s.activeApiProfile === p.name ? '' : s.activeApiProfile;
        updateSettings({ apiProfiles: profiles, activeApiProfile: newActive });
        refreshProfileDropdown();
        refreshEmbeddingProfileDropdown();
        showToast(`预设"${p.name}"已删除`, 'info');
    });

    // v8.2.7 初始化两个预设下拉框
    refreshProfileDropdown();
    refreshEmbeddingProfileDropdown();

}

// ═══ 折叠设置面板 ═══

function initCollapsibleSettings() {
    document.querySelectorAll('.bb-settings-section-header').forEach(header => {
        header.addEventListener('click', () => {
            const body = header.nextElementSibling;
            const chevron = header.querySelector('.bb-settings-chevron i');
            const isCollapsed = body.style.display === 'none';

            body.style.display = isCollapsed ? '' : 'none';
            if (chevron) {
                if (isCollapsed) {
                    chevron.classList.remove('fa-chevron-right');
                    chevron.classList.add('fa-chevron-down');
                } else {
                    chevron.classList.remove('fa-chevron-down');
                    chevron.classList.add('fa-chevron-right');
                }
            }

            const sectionKey = header.dataset.section;
            const s = getSettings();
            if (!s._collapsedSections) s._collapsedSections = {};
            s._collapsedSections[sectionKey] = !isCollapsed;
            updateSettings({ _collapsedSections: s._collapsedSections });
        });
    });

    // 恢复折叠状态
    const s = getSettings();
    const collapsed = s._collapsedSections || {};
    document.querySelectorAll('.bb-settings-section-header').forEach(header => {
        const key = header.dataset.section;
        if (collapsed[key]) {
            const body = header.nextElementSibling;
            if (body) body.style.display = 'none';
            const chevron = header.querySelector('.bb-settings-chevron i');
            if (chevron) {
                chevron.classList.remove('fa-chevron-down');
                chevron.classList.add('fa-chevron-right');
            }
        }
    });
}

function bindCheckbox(selector, settingKey, onChange) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.checked = getSettings()[settingKey];
    el.addEventListener('change', () => {
        updateSettings({ [settingKey]: el.checked });
        if (onChange) onChange(el.checked);
    });
}

function bindSelect(selector, settingKey) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.value = getSettings()[settingKey] || '';
    el.addEventListener('change', () => updateSettings({ [settingKey]: el.value }));
}

function bindInput(selector, settingKey, type) {
    const el = document.querySelector(selector);
    if (!el) return;
    const val = getSettings()[settingKey];
    el.value = val ?? '';
    el.addEventListener('change', () => {
        const v = type === 'number' ? Number(el.value) : el.value;
        updateSettings({ [settingKey]: v });
    });
}

function getChatId() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.chatId || (ctx.chat?.[0]?.chatId) || null;
    } catch { return null; }
}

function buildDefaultSlotName(prefix, base = '') {
    const d = new Date();
    const stamp = [
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
        String(d.getHours()).padStart(2, '0'),
        String(d.getMinutes()).padStart(2, '0'),
    ].join('');
    const safeBase = String(base || '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 18);
    return safeBase ? `${safeBase}-${prefix}-${stamp}` : `${prefix}-${stamp}`;
}

// ═══════════════════════════════════════════════════════════
//  v9.3.1 存档救援
// ═══════════════════════════════════════════════════════════

let pendingSlotRescue = null;
let slotRescueNoticeShown = new Set();

/**
 * 角色载入时的存档命名空间救援。
 *
 * v9.3.0 及更早把 characters 数组下标当作存档命名空间，
 * 导入/删除角色后下标平移，存档就"消失"了（其实还躺在旧命名空间里）。
 * 这里在读写任何存档之前先把它们找回来。
 */
async function runSlotRescueOnLoad(charId) {
    if (!charId) return null;
    const result = await autoRescueSlots(charId);
    if (!result) return null;

    if (result.status === 'migrated') {
        const r = result.result || {};
        pendingSlotRescue = null;
        showTopNotification(
            `已找回历史存档：从命名空间「${r.legacyId}」恢复 ${r.slotCount} 个存档、${r.entries} 条数据`,
            'success',
        );
        if (getSettings().debugLogging) {
            console.log('[BB-Memory] 存档自动救援完成:', r);
        }
        refreshSidebar();
        refreshFloatingHubData();
        return result;
    }

    if (result.status === 'review') {
        pendingSlotRescue = { charId, candidates: result.candidates, report: result.report };
        const key = `${charId}:${result.candidates.length}`;
        if (!slotRescueNoticeShown.has(key)) {
            slotRescueNoticeShown.add(key);
            const total = result.candidates.reduce((sum, c) => sum + (c.totalEntries || 0), 0);
            showTopNotification(
                `检测到 ${result.candidates.length} 组未认领的历史存档（共 ${total} 条），`
                + '当前角色存档为空。请打开「存档救援」确认归属。',
                'warning',
            );
        }
        renderSlotRescueBanner();
        return result;
    }

    pendingSlotRescue = null;
    renderSlotRescueBanner();
    return result;
}

function renderSlotRescueBanner() {
    const host = document.querySelector('#bb_slot_rescue_banner');
    if (!host) return;
    if (!pendingSlotRescue?.candidates?.length) {
        host.innerHTML = '';
        host.style.display = 'none';
        return;
    }
    const total = pendingSlotRescue.candidates.reduce((sum, c) => sum + (c.totalEntries || 0), 0);
    host.style.display = '';
    host.innerHTML = `
        <div class="bb-rescue-banner">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <div class="bb-rescue-banner-text">
                <strong>发现 ${pendingSlotRescue.candidates.length} 组未认领的历史存档</strong>
                <small>共 ${total} 条数据。角色下标变化会让旧存档失联，点击确认归属即可找回。</small>
            </div>
            <button class="menu_button bb-rescue-banner-btn" type="button">
                <i class="fa-solid fa-life-ring"></i> 存档救援
            </button>
        </div>`;
    host.querySelector('.bb-rescue-banner-btn')?.addEventListener('click', () => openSlotRescuePanel());
}

function rescueConfidenceMeta(confidence) {
    if (confidence === 'high') return { label: '高置信', cls: 'high', icon: 'fa-circle-check' };
    if (confidence === 'medium') return { label: '中置信', cls: 'medium', icon: 'fa-circle-question' };
    return { label: '低置信', cls: 'low', icon: 'fa-circle-exclamation' };
}

function renderRescueNamespaceCard(ns) {
    const meta = rescueConfidenceMeta(ns.confidence);
    const slotList = ns.slots
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map(s => {
            const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '时间未知';
            const c = s.counts || {};
            const detail = [
                c.memories ? `记忆 ${c.memories}` : '',
                c.npc ? `NPC ${c.npc}` : '',
                c.items ? `物品 ${c.items}` : '',
                c.milestones ? `里程碑 ${c.milestones}` : '',
                c.timeline ? `时间线 ${c.timeline}` : '',
                c.map ? `地点 ${c.map}` : '',
            ].filter(Boolean).join(' · ') || '空存档';
            return `
                <label class="bb-rescue-slot">
                    <input type="checkbox" class="bb-rescue-slot-cb" value="${escapeHtml(s.name)}" checked />
                    <span class="bb-rescue-slot-name">${escapeHtml(s.name)}</span>
                    <span class="bb-rescue-slot-count">${s.count} 条</span>
                    <span class="bb-rescue-slot-detail">${escapeHtml(detail)}</span>
                    <span class="bb-rescue-slot-time">${escapeHtml(when)}</span>
                    ${s.titles?.length ? `<span class="bb-rescue-slot-preview">内容预览：${escapeHtml(s.titles.join('、'))}</span>` : ''}
                </label>`;
        }).join('');

    const missing = ns.fromIndexOnly?.length
        ? `<div class="bb-rescue-missing"><i class="fa-solid fa-circle-minus"></i> 索引中登记但数据已缺失：${escapeHtml(ns.fromIndexOnly.join('、'))}</div>`
        : '';
    const claimed = ns.claimedByOther
        ? `<div class="bb-rescue-claimed"><i class="fa-solid fa-lock"></i> 该命名空间已被其它角色认领（${escapeHtml(ns.claimedBy || '')}）。仍可复制，但请确认是否真属于当前角色。</div>`
        : '';

    return `
        <div class="bb-rescue-ns" data-ns="${escapeHtml(ns.charId)}">
            <div class="bb-rescue-ns-head">
                <span class="bb-rescue-badge ${meta.cls}"><i class="fa-solid ${meta.icon}"></i> ${meta.label}</span>
                <strong class="bb-rescue-ns-id">命名空间 ${escapeHtml(ns.charId)}</strong>
                ${ns.displayName ? `<span class="bb-rescue-ns-name">${escapeHtml(ns.displayName)}</span>` : ''}
                <span class="bb-rescue-ns-sum">${ns.slotCount} 个存档 / ${ns.totalEntries} 条</span>
            </div>
            <div class="bb-rescue-reason"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(ns.reason)}</div>
            ${claimed}
            ${missing}
            <div class="bb-rescue-slots">${slotList}</div>
            <div class="bb-rescue-ns-actions">
                <button class="menu_button bb-rescue-select-all" type="button"><i class="fa-solid fa-check-double"></i> 全选</button>
                <button class="menu_button bb-rescue-select-none" type="button"><i class="fa-solid fa-square"></i> 全不选</button>
                <button class="menu_button bb-rescue-adopt" type="button"><i class="fa-solid fa-hand-holding-heart"></i> 认领到当前角色</button>
            </div>
        </div>`;
}

/**
 * 存档救援面板：列出所有历史命名空间，由用户确认认领。
 * 认领是"复制"，旧数据原样保留，可反复核对。
 */
export async function openSlotRescuePanel() {
    document.querySelector('.bb-rescue-overlay')?.remove();
    const charId = getCharacterId();
    if (!charId) { showToast('请先进入角色对话', 'warning'); return; }

    const overlay = document.createElement('div');
    overlay.className = 'bb-rescue-overlay';
    overlay.innerHTML = `
        <div class="bb-rescue-dialog">
            <div class="bb-rescue-header">
                <i class="fa-solid fa-life-ring"></i>
                <div>
                    <strong>存档救援</strong>
                    <small>找回因角色下标变化而失联的历史存档</small>
                </div>
                <button class="bb-rescue-close" type="button" title="关闭">&times;</button>
            </div>
            <div class="bb-rescue-body"><div class="bb-rescue-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在扫描本地存档命名空间...</div></div>
            <div class="bb-rescue-footer">
                <span class="bb-rescue-status"></span>
                <button class="menu_button bb-rescue-refresh" type="button"><i class="fa-solid fa-rotate"></i> 重新扫描</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.bb-rescue-close')?.addEventListener('click', close);

    const body = overlay.querySelector('.bb-rescue-body');
    const status = overlay.querySelector('.bb-rescue-status');

    const render = async () => {
        body.innerHTML = '<div class="bb-rescue-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在扫描本地存档命名空间...</div>';
        let report;
        try {
            const { collectRescueCandidates } = await import('./slot-identity.js');
            report = await collectRescueCandidates(charId);
        } catch (e) {
            body.innerHTML = `<div class="bb-rescue-error">扫描失败：${escapeHtml(e.message || String(e))}</div>`;
            return;
        }

        const charName = getCharacterDisplayName(charId);
        const head = `
            <div class="bb-rescue-current">
                <div><strong>当前角色</strong>：${escapeHtml(charName || '(未知)')}</div>
                <div><strong>稳定命名空间</strong>：<code>${escapeHtml(report.stableId || '(无法解析)')}</code></div>
                <div><strong>本命名空间已有</strong>：${report.ownSlotCount} 个存档 / ${report.ownEntries} 条</div>
                <div><strong>当前角色下标</strong>：${escapeHtml(String(report.legacyIndex ?? '(无)'))}${report.metaCharId ? ` · 聊天云端索引记录：<code>${escapeHtml(report.metaCharId)}</code>` : ''}</div>
            </div>
            <div class="bb-rescue-help">
                <i class="fa-solid fa-shield-halved"></i>
                认领 = <strong>复制</strong>到当前角色的稳定命名空间。旧数据完整保留，不会被删除，可以反复核对。
                同名存档会自动加 "-救援" 后缀，不覆盖现有存档。
            </div>`;

        if (!report.candidates.length) {
            body.innerHTML = `${head}<div class="bb-rescue-empty"><i class="fa-solid fa-circle-check"></i> 没有发现其它历史存档命名空间。</div>`;
            status.textContent = `已扫描 ${report.scanned} 个存档相关键`;
            return;
        }

        body.innerHTML = head
            + report.candidates.map(renderRescueNamespaceCard).join('')
            + (report.unresolved?.length
                ? `<div class="bb-rescue-unresolved"><strong>无法归类的键（${report.unresolved.length}）</strong>
                     <div>${report.unresolved.map(u => `<code>${escapeHtml(u.key)}</code> (${u.count} 条)`).join('<br>')}</div>
                     <small>这些键的命名空间无法自动解析，如需处理请联系开发者，数据不会被自动改动。</small></div>`
                : '');
        status.textContent = `已扫描 ${report.scanned} 个存档相关键 · ${report.candidates.length} 组候选`;

        body.querySelectorAll('.bb-rescue-ns').forEach(card => {
            const boxes = () => [...card.querySelectorAll('.bb-rescue-slot-cb')];
            card.querySelector('.bb-rescue-select-all')?.addEventListener('click', () => {
                boxes().forEach(b => { b.checked = true; });
            });
            card.querySelector('.bb-rescue-select-none')?.addEventListener('click', () => {
                boxes().forEach(b => { b.checked = false; });
            });
            card.querySelector('.bb-rescue-adopt')?.addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                const legacyId = card.dataset.ns;
                const slotNames = boxes().filter(b => b.checked).map(b => b.value);
                if (!slotNames.length) { showToast('请至少勾选一个存档', 'warning'); return; }
                const ok = confirm(
                    `确认把命名空间「${legacyId}」中的 ${slotNames.length} 个存档认领到当前角色？\n\n`
                    + '这是复制操作，原数据保留不变。'
                );
                if (!ok) return;
                const orig = btn.innerHTML;
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在认领...';
                try {
                    const { migrateLegacyNamespace } = await import('./slot-identity.js');
                    const result = await migrateLegacyNamespace(legacyId, charId, { slotNames });
                    const renamed = result.migrated.filter(m => m.from !== m.to);
                    showTopNotification(
                        `已认领 ${result.slotCount} 个存档、${result.entries} 条数据`
                        + (renamed.length ? `；${renamed.length} 个因同名重命名为 ${renamed.map(m => m.to).join('、')}` : ''),
                        'success',
                    );
                    if (result.skipped.length) {
                        showToast(`${result.skipped.length} 个存档未能认领，详见控制台`, 'warning');
                        console.warn('[BB-Memory] 未认领的存档:', result.skipped);
                    }
                    pendingSlotRescue = null;
                    renderSlotRescueBanner();
                    refreshSidebar();
                    refreshFloatingHubData();
                    await render();
                } catch (err) {
                    showToast(`认领失败：${err.message}`, 'error');
                    btn.disabled = false;
                    btn.innerHTML = orig;
                }
            });
        });
    };

    overlay.querySelector('.bb-rescue-refresh')?.addEventListener('click', () => render());
    await render();
}

/**
 * v9.3.1 检测当前聊天是否为分支。
 * ST 的分支聊天文件名通常带 " Branch #" / "branch" 标记，
 * 同时 chatMetadata 里会保留来源信息。任一命中即视为分支。
 */
function detectBranchChat(chatId) {
    try {
        const text = String(chatId || '');
        if (/branch/i.test(text) || /分支/.test(text)) return true;
        const ctx = SillyTavern.getContext();
        const meta = ctx?.chatMetadata || {};
        if (meta.branched_from || meta.branchedFrom || meta.main_chat) return true;
    } catch { /* ignore */ }
    return false;
}

function showChatSwitchSlotDialog({
    sourceSlot, sourceCount, sourceEmbeddingCount, currentChatId,
    currentCount = 0, isBranch = false, existingSlots = [],
}) {
    return new Promise((resolve) => {
        document.querySelector('.bb-slot-switch-overlay')?.remove();

        const canBranch = Boolean(sourceSlot) && Number(sourceCount || 0) > 0;
        const branchDefault = buildDefaultSlotName('if', sourceSlot);
        const emptyDefault = buildDefaultSlotName('new');
        const slotOptions = (existingSlots || [])
            .filter(s => s && s.name)
            .map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} (${Number(s.count || 0)} 条)</option>`)
            .join('');
        const overlay = document.createElement('div');
        overlay.className = 'bb-slot-switch-overlay';
        overlay.innerHTML = `
            <div class="bb-slot-switch-dialog">
                <div class="bb-slot-switch-header">
                    <i class="fa-solid fa-code-branch"></i>
                    <div>
                        <strong>${isBranch ? '检测到分支窗口' : '检测到未绑定的窗口'}</strong>
                        <small>当前聊天：${escapeHtml(String(currentChatId || '').slice(0, 24))}</small>
                    </div>
                    <button class="bb-slot-switch-close" type="button" title="稍后处理（会自动隔离到新存档）">&times;</button>
                </div>
                <div class="bb-slot-switch-body">
                    <div class="bb-slot-switch-note">
                        这个窗口还没有绑定存档。请选择它该使用哪个存档 ——
                        ${canBranch ? `可以基于 <strong>「${escapeHtml(sourceSlot)}」</strong> 新增 if 分支，` : ''}
                        也可以新建空存档或绑定到已有存档。
                    </div>
                    <div class="bb-slot-switch-safety">
                        <i class="fa-solid fa-shield-halved"></i>
                        为避免串档，未绑定的窗口不会写入任何已有存档。若直接关闭本窗口，
                        BB-Memory 会自动为它创建一个隔离存档。
                    </div>
                    <div class="bb-slot-switch-stats">
                        <span><i class="fa-solid fa-layer-group"></i> 基础条目：<strong>${Number(sourceCount || 0)}</strong></span>
                        <span><i class="fa-solid fa-vector-square"></i> 本地向量：<strong>${Number(sourceEmbeddingCount || 0)}</strong></span>
                        <span><i class="fa-solid fa-comment-dots"></i> 本窗口现有：<strong>${Number(currentCount || 0)}</strong></span>
                    </div>
                    <label class="bb-slot-switch-field">
                        <span>新增 if 分支名称</span>
                        <input class="bb-input" id="bb_slot_switch_branch_name" value="${escapeHtml(branchDefault)}" ${canBranch ? '' : 'disabled'} />
                    </label>
                    ${canBranch ? '' : '<div class="bb-slot-switch-warning"><i class="fa-solid fa-triangle-exclamation"></i> 没有可作为基础的已绑定存档，无法复制为 if 分支；可以新建空存档或绑定已有存档。</div>'}
                    <label class="bb-slot-switch-field">
                        <span>新建空存档名称</span>
                        <input class="bb-input" id="bb_slot_switch_empty_name" value="${escapeHtml(emptyDefault)}" />
                    </label>
                    ${slotOptions ? `
                    <label class="bb-slot-switch-field">
                        <span>绑定到已有存档</span>
                        <select class="bb-input" id="bb_slot_switch_existing_name">${slotOptions}</select>
                    </label>` : ''}
                </div>
                <div class="bb-slot-switch-actions">
                    <button class="menu_button" id="bb_slot_switch_cancel" type="button">稍后处理</button>
                    ${slotOptions ? '<button class="menu_button" id="bb_slot_switch_existing" type="button"><i class="fa-solid fa-link"></i> 绑定已有</button>' : ''}
                    <button class="menu_button" id="bb_slot_switch_empty" type="button">
                        <i class="fa-solid fa-file-circle-plus"></i> 新建空存档
                    </button>
                    <button class="menu_button" id="bb_slot_switch_branch" type="button" ${canBranch ? '' : 'disabled'}>
                        <i class="fa-solid fa-code-branch"></i> 新增 if 分支
                    </button>
                </div>
            </div>`;

        const done = (value) => {
            overlay.remove();
            resolve(value);
        };
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
        document.body.appendChild(overlay);

        const branchInput = overlay.querySelector('#bb_slot_switch_branch_name');
        const emptyInput = overlay.querySelector('#bb_slot_switch_empty_name');
        overlay.querySelector('.bb-slot-switch-close')?.addEventListener('click', () => done(null));
        overlay.querySelector('#bb_slot_switch_cancel')?.addEventListener('click', () => done(null));
        overlay.querySelector('#bb_slot_switch_branch')?.addEventListener('click', () => {
            const slotName = branchInput?.value?.trim();
            if (!slotName) { showToast('请输入 if 分支存档名称', 'warning'); return; }
            done({ action: 'branch', slotName });
        });
        overlay.querySelector('#bb_slot_switch_empty')?.addEventListener('click', () => {
            const slotName = emptyInput?.value?.trim();
            if (!slotName) { showToast('请输入新存档名称', 'warning'); return; }
            done({ action: 'new', slotName });
        });
        overlay.querySelector('#bb_slot_switch_existing')?.addEventListener('click', () => {
            const slotName = overlay.querySelector('#bb_slot_switch_existing_name')?.value?.trim();
            if (!slotName) { showToast('请选择要绑定的存档', 'warning'); return; }
            done({ action: 'existing', slotName });
        });
        [branchInput, emptyInput].forEach(input => {
            input?.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') done(null);
                if (e.key === 'Enter') {
                    const action = input === branchInput ? 'branch' : 'new';
                    const slotName = input.value.trim();
                    if (!slotName) return;
                    if (action === 'branch' && !canBranch) return;
                    done({ action, slotName });
                }
            });
        });
        setTimeout(() => (canBranch ? branchInput : emptyInput)?.focus(), 80);
    });
}

/**
 * v9.3.1 切换窗口前的自动保存。
 *
 * 【修复分支串档】旧实现在聊天没有绑定记录时回退到全局 currentSlotName，
 * 然后直接把该聊天的数据覆盖进那个槽。典型后果：在分支 if 里点了"稍后处理"
 * 导致分支未绑定，之后切走时分支数据被写进了正剧存档。
 *
 * 新规则：只有**明确绑定**的聊天才能触发自动保存，且带上归属校验。
 * 没有绑定就不写，改为返回 unbound 让上层去引导用户显式选择。
 */
async function saveObservedChatSlot(charId, chatId, options = {}) {
    if (!charId || !chatId) return null;
    const boundSlot = getBoundSlotName(charId, chatId);
    if (!boundSlot) {
        const summary = await getChatSlotDataSummary(chatId).catch(() => ({ count: 0 }));
        return { unbound: true, count: summary?.count || 0 };
    }
    try {
        const summary = await getChatSlotDataSummary(chatId);
        if (summary.count <= 0 && options.allowEmpty !== true) {
            return { skipped: true, reason: 'empty', slotName: boundSlot, count: 0 };
        }
        const saved = await saveToSlot(charId, chatId, boundSlot, {
            syncCloud: false,
            expectChatId: chatId,
        });
        return { ...saved, slotName: boundSlot };
    } catch (e) {
        // 归属冲突不是"失败"，而是守卫成功拦下了一次串档
        console.warn('[BB-Memory] 切换窗口前置保存被拦下或失败:', e.message || e);
        showTopNotification(`已阻止一次可能的存档串档：${e.message}`, 'warning');
        return { blocked: true, error: e.message, slotName: boundSlot };
    }
}

async function loadBoundSlotForObservedChat(charId, chatId, slotName, previousSlotName = '') {
    const progress = createProgressToast(`正在切换 BB-Memory 存档到「${slotName}」...`);
    try {
        const loaded = await loadFromSlot(charId, chatId, slotName, { preserveIds: true });
        const fromText = previousSlotName && previousSlotName !== slotName ? `（由「${previousSlotName}」切换）` : '';
        showTopNotification(`已加载当前窗口绑定存档「${slotName}」${fromText}：${loaded.count} 条`, 'success');
        refreshSidebar();
        refreshFloatingHubData();
        return loaded;
    } finally {
        if (progress) {
            progress.textContent = '存档切换完成';
            setTimeout(() => progress.remove(), 1200);
        }
    }
}

async function maybePromptChatSwitchSlot({ prevChatId, prevCharId, chatId, charId }) {
    if (!chatId || !charId) return;

    const hadPrevious = !!(prevChatId && prevCharId);
    const switchedChat = hadPrevious && String(prevChatId) !== String(chatId);
    const switchedChar = hadPrevious && String(prevCharId) !== String(charId);
    const switched = switchedChat || switchedChar;

    try {
        // 1. 先保存上一个窗口 —— 仅当它有明确绑定时
        if (switched && prevChatId && prevCharId) {
            await saveObservedChatSlot(prevCharId, prevChatId);
        }

        // 2. 当前窗口有明确绑定 -> 按绑定加载
        const boundSlot = getBoundSlotName(charId, chatId);
        if (boundSlot) {
            const currentSlot = getSettings().currentSlotName || 'default';
            if (switched || currentSlot !== boundSlot) {
                await loadBoundSlotForObservedChat(charId, chatId, boundSlot, currentSlot);
            } else {
                bindChatToSlot(charId, chatId, boundSlot, { overwrite: false });
            }
            await claimSlotForChat(charId, boundSlot, chatId);
            return;
        }

        // 3. 当前窗口没有绑定。
        //    v9.3.1 关键修复：绝不再把它静默绑定到 currentSlotName（上一个聊天的槽）。
        //    未绑定的窗口一律走显式选择流程。
        const promptKey = `${charId}:${prevChatId || 'init'}->${chatId}`;
        if (handledChatSwitchPrompts.has(promptKey) || chatSwitchPromptOpen) return;

        const currentSummary = await getChatSlotDataSummary(chatId);
        const isBranch = detectBranchChat(chatId);
        const sourceSlot = (prevCharId && prevChatId && String(prevCharId) === String(charId))
            ? getBoundSlotName(prevCharId, prevChatId)
            : '';

        let sourceCount = 0;
        let sourceEmbeddingCount = 0;
        if (sourceSlot) {
            const slots = await listSlots(charId);
            const source = slots.find(s => s.name === sourceSlot);
            sourceCount = source?.count || 0;
            sourceEmbeddingCount = source?.embeddingCount || source?.remoteEmbeddings || 0;
        }

        handledChatSwitchPrompts.add(promptKey);
        chatSwitchPromptOpen = true;
        const choice = await showChatSwitchSlotDialog({
            sourceSlot,
            sourceCount,
            sourceEmbeddingCount,
            currentChatId: chatId,
            currentCount: currentSummary.count || 0,
            isBranch,
            existingSlots: await listSlots(charId),
        });
        chatSwitchPromptOpen = false;

        // 「稍后处理」不再留下悬空状态：自动落一个专属新槽，
        // 这样后续自动保存有明确目标，不会误伤任何已有存档。
        if (!choice) {
            const fallbackName = buildDefaultSlotName('未命名', getCharacterDisplayName(charId));
            await createEmptySlot(charId, fallbackName).catch(() => {});
            bindChatToSlot(charId, chatId, fallbackName);
            await claimSlotForChat(charId, fallbackName, chatId);
            if (currentSummary.count > 0) {
                await saveToSlot(charId, chatId, fallbackName, { syncCloud: false, expectChatId: chatId }).catch(() => {});
            }
            showTopNotification(
                `当前窗口未选择存档，已自动隔离到新存档「${fallbackName}」，不会影响其它存档`,
                'warning',
            );
            refreshSidebar();
            refreshFloatingHubData();
            return;
        }

        const progress = createProgressToast('正在切换 BB-Memory 存档...');
        try {
            if (choice.action === 'branch') {
                if (!sourceSlot) throw new Error('没有可作为分支基础的已绑定存档');
                progress && (progress.textContent = '正在复制当前存档为 if 分支...');
                await cloneSlot(charId, sourceSlot, choice.slotName, { syncCloud: false, boundChatId: chatId });
                const loaded = await loadFromSlot(charId, chatId, choice.slotName, { preserveIds: true });
                showTopNotification(`已基于「${sourceSlot}」创建 if 分支「${choice.slotName}」，复制 ${loaded.count} 条`, 'success');
            } else if (choice.action === 'new') {
                progress && (progress.textContent = '正在创建空存档...');
                await createEmptySlot(charId, choice.slotName);
                const loaded = await loadFromSlot(charId, chatId, choice.slotName, { preserveIds: true });
                showTopNotification(`已新建并切换到存档「${choice.slotName}」 (${loaded.count} 条)`, 'success');
            } else if (choice.action === 'existing') {
                // v9.3.1 绑定到已有存档：先校验该槽是否已归属别的聊天
                const owner = await getSlotOwnerChatId(charId, choice.slotName);
                if (owner && String(owner) !== String(chatId)) {
                    const ok = confirm(
                        `存档「${choice.slotName}」当前归属另一个聊天窗口。\n`
                        + '继续绑定会让两个窗口共用同一存档，之后的自动保存可能互相覆盖。\n\n确定继续吗？'
                    );
                    if (!ok) throw new Error('已取消绑定');
                }
                progress && (progress.textContent = `正在加载存档「${choice.slotName}」...`);
                const loaded = await loadFromSlot(charId, chatId, choice.slotName, { preserveIds: true });
                showTopNotification(`已绑定并加载存档「${choice.slotName}」 (${loaded.count} 条)`, 'success');
            }
            refreshSidebar();
            refreshFloatingHubData();
        } finally {
            if (progress) {
                progress.textContent = '存档切换完成';
                setTimeout(() => progress.remove(), 1200);
            }
        }
    } catch (e) {
        chatSwitchPromptOpen = false;
        showTopNotification(`窗口存档处理失败: ${e.message}`, 'error');
    }
}

// ═══ 反馈包装器 ═══

function withFeedback(btn, fn, { loadingText, successText, errorText } = {}) {
    if (btn.disabled) return Promise.resolve();
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${loadingText || '处理中...'}`;
    const restore = () => { btn.disabled = false; btn.innerHTML = origHTML; };
    return fn()
        .then(r => { if (successText) showToast(successText, 'success'); restore(); return r; })
        .catch(e => { if (errorText) showToast(`${errorText}: ${e.message}`, 'error'); else showToast(e.message, 'error'); restore(); throw e; });
}

// ═══ 记忆维护面板 ═══

function showMaintenancePopup(chatId, result) {
    const existing = document.querySelector('.bb-maint-overlay');
    if (existing) existing.remove();

    const issues = result?.issues || [];
    const issueCount = result?.issueCount ?? issues.length;
    const totalItems = result?.totalItems ?? 0;
    const overlay = document.createElement('div');
    overlay.className = 'bb-maint-overlay';

    const panel = document.createElement('div');
    panel.className = 'bb-maint-panel';
    panel.style.cssText = 'display:flex;flex-direction:column;max-height:80vh;';

    // Header
    const header = document.createElement('div');
    header.className = 'bb-maint-header';
    header.style.cssText = 'display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';
    header.innerHTML = `
        <i class="fa-solid fa-toolbox"></i>
        <div style="display:flex;flex-direction:column;flex:1;">
            <div style="display:flex;align-items:center;gap:8px;">
                <strong>记忆维护</strong>
                <span class="bb-maint-cat-count" style="font-size:0.85em;">${issueCount}条待处理</span>
            </div>
            <p style="margin:4px 0 0;font-size:0.85em;opacity:0.7;">共 ${totalItems} 条条目</p>
        </div>
        <button class="bb-maint-close-btn" style="background:none;border:none;color:inherit;font-size:24px;cursor:pointer;opacity:0.6;line-height:1;padding:0 4px;">&times;</button>
    `;
    panel.appendChild(header);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';
    const pendingBtn = document.createElement('button');
    pendingBtn.textContent = `待维护 (${issueCount})`;
    pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:0.9em;font-weight:600;border-bottom:2px solid #fab387;';
    const resolvedBtn = document.createElement('button');
    resolvedBtn.textContent = '已维护';
    resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
    tabBar.appendChild(pendingBtn);
    tabBar.appendChild(resolvedBtn);
    const healthBtn = document.createElement('button');
    healthBtn.textContent = '体检';
    healthBtn.title = '记忆健康检查 — 数据完整性、孤立条目、近似重复等';
    healthBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
    tabBar.appendChild(healthBtn);
    panel.appendChild(tabBar);

    // Body
    const body = document.createElement('div');
    body.className = 'bb-maint-body';
    body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 20px;min-height:0;';
    panel.appendChild(body);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const close = () => { document.removeEventListener('keydown', onKeyDown); overlay.remove(); };
    header.querySelector('.bb-maint-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const onKeyDown = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKeyDown);

    const issueTypeDefs = {
        idle_transient_memory: { icon: 'fa-regular fa-clock', label: '瞬时记忆（长期未命中）' },
        dusty_item:           { icon: 'fa-solid fa-box-archive', label: '积灰物品' },
        status_changed_item:   { icon: 'fa-solid fa-box',     label: '状态变更的物品' },
        compressible_timeline: { icon: 'fa-solid fa-compress', label: '可压缩的里程碑' },
        low_tier_npc:          { icon: 'fa-solid fa-user',     label: '低优先级NPC' },
        foreshadow:            { icon: 'fa-solid fa-eye',      label: '待确认伏笔' },
    };

    function refreshBadges() {
        const total = body.querySelectorAll('.bb-maint-issue-item').length;
        const badgeEl = header.querySelector('.bb-maint-cat-count');
        if (badgeEl) badgeEl.textContent = total + '条待处理';
        pendingBtn.textContent = `待维护 (${total})`;
        // 移除空的分类
        body.querySelectorAll('.bb-maint-category').forEach(cat => {
            if (!cat.querySelector('.bb-maint-issue-item')) cat.remove();
        });
        if (total === 0) {
            body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">所有待维护项已处理</div>';
        }
    }

    function renderPending() {
        pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:13px;font-weight:600;border-bottom:2px solid #fab387;';
        resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;opacity:0.6;border-bottom:2px solid transparent;';
        healthBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        body.innerHTML = '';

        const grouped = {};
        for (const iss of issues) {
            if (!grouped[iss.type]) grouped[iss.type] = [];
            grouped[iss.type].push(iss);
        }

        if (issues.length === 0) {
            body.innerHTML = `<div style="text-align:center;padding:40px;opacity:0.6;">
                <i class="fa-solid fa-circle-check" style="font-size:2em;color:#4caf50;display:block;margin-bottom:12px;"></i>
                记忆状态良好，没有待维护项
            </div>`;
            return;
        }

        // Legend
        const legend = document.createElement('div');
        legend.className = 'bb-maint-legend';
        legend.style.cssText = 'padding:0 0 12px;border:none;display:flex;gap:14px;flex-wrap:wrap;font-size:0.8em;opacity:0.7;';
        legend.innerHTML = [
            ['#4caf50','保留'],['#2196f3','升级'],['#ff9800','降级'],['#9e9e9e','归档'],['#f44336','删除'],['#9c27b0','压缩']
        ].map(([c,l]) => `<span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block;"></span>${l}</span>`).join('');
        body.appendChild(legend);

        for (const [type, typeIssues] of Object.entries(grouped)) {
            const meta = issueTypeDefs[type] || { icon: 'fa-solid fa-circle', label: type };
            const cat = document.createElement('div');
            cat.className = 'bb-maint-category';

            const catHeader = document.createElement('div');
            catHeader.className = 'bb-maint-cat-header';
            catHeader.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;cursor:pointer;';
            catHeader.innerHTML = `<i class="${meta.icon}"></i><span style="flex:1;font-size:0.9em;font-weight:500;">${meta.label}</span><span class="bb-maint-cat-count">${typeIssues.length}条</span><i class="fa-solid fa-chevron-down" style="font-size:0.75em;opacity:0.5;"></i>`;

            const itemList = document.createElement('div');
            itemList.className = 'bb-maint-cat-items';

            for (const iss of typeIssues) {
                const item = iss.item;
                const label = item.name || item.title || item.event || item.id;
                const itemDiv = document.createElement('div');
                itemDiv.className = 'bb-maint-issue-item';
                itemDiv.dataset.collection = iss.collection;
                itemDiv.dataset.id = item.id;
                itemDiv.style.cssText = 'display:flex;align-items:center;padding:6px 0;gap:8px;border-bottom:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,0.05));';

                const infoDiv = document.createElement('div');
                infoDiv.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;gap:2px;';
                infoDiv.innerHTML = `<span class="bb-maint-issue-title" style="font-size:0.85em;">${escapeHtml(label)}</span><span class="bb-maint-issue-reason" style="font-size:0.75em;opacity:0.5;">${escapeHtml(iss.reason || '')}</span>`;

                const actionDiv = document.createElement('div');
                actionDiv.style.cssText = 'display:flex;gap:3px;flex-shrink:0;';

                const addBtn = (op, color, text) => {
                    const btn = document.createElement('button');
                    btn.style.cssText = `padding:2px 6px;border:1px solid ${color};background:transparent;color:${color};border-radius:4px;cursor:pointer;font-size:0.75em;`;
                    btn.textContent = text;
                    btn.addEventListener('mouseenter', () => { btn.style.background = color + '22'; });
                    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        withFeedback(btn, async () => {
                            await performMaintenance(chatId, [{ collection: iss.collection, id: item.id, op }]);
                            itemDiv.remove();
                            // 同步移除 result.issues 中的对应项
                            const idx = result.issues.findIndex(i => i.item.id === item.id && i.collection === iss.collection);
                            if (idx >= 0) result.issues.splice(idx, 1);
                            refreshBadges();
                        }, { successText: `${text}: ${label}` });
                    });
                    actionDiv.appendChild(btn);
                };
                if (type === 'dusty_item') {
                    addBtn('archive_item', '#9e9e9e', '归档');
                    addBtn('item_to_vector', '#2196f3', '升稳定');
                    addBtn('item_to_eternal', '#ff9800', '升永恒');
                } else {
                    addBtn('keep', '#4caf50', '保留');
                    addBtn('promote', '#2196f3', '升级');
                    addBtn('demote', '#ff9800', '降级');
                    addBtn('delete', '#f44336', '删除');
                }
                if (type === 'compressible_timeline') {
                    addBtn('compress_timeline', '#9c27b0', '压缩');
                }

                itemDiv.appendChild(infoDiv);
                itemDiv.appendChild(actionDiv);
                itemList.appendChild(itemDiv);
            }

            catHeader.addEventListener('click', () => {
                const hidden = itemList.style.display === 'none';
                itemList.style.display = hidden ? '' : 'none';
                const chevron = catHeader.querySelector('.fa-chevron-down');
                if (chevron) chevron.style.transform = hidden ? '' : 'rotate(-90deg)';
            });

            cat.appendChild(catHeader);
            cat.appendChild(itemList);
            body.appendChild(cat);
        }

        // Bottom actions
        const bottomBar = document.createElement('div');
        bottomBar.style.cssText = 'display:flex;gap:8px;padding:12px 0 0;flex-wrap:wrap;border-top:1px solid var(--SmartThemeBorderColor,#45475a);margin-top:8px;';
        const keepAllBtn = document.createElement('button');
        keepAllBtn.className = 'bb-maint-btn-auto menu_button';
        keepAllBtn.textContent = '全部保留';
        keepAllBtn.addEventListener('click', () => {
            withFeedback(keepAllBtn, async () => {
                const items = body.querySelectorAll('.bb-maint-issue-item');
                const actions = [...items].map(el => ({ collection: el.dataset.collection, id: el.dataset.id, op: 'keep' }));
                const res = await performMaintenance(chatId, actions);
                body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">所有待维护项已保留</div>';
                // 同步更新 result.issues
                const actionIds = new Set(actions.map(a => a.id));
                result.issues = result.issues.filter(i => !actionIds.has(i.item.id));
                refreshBadges();
            }, { loadingText: '正在全部保留...', successText: '已全部保留' });
        });
        const laterBtn = document.createElement('button');
        laterBtn.className = 'bb-maint-btn-later menu_button';
        laterBtn.textContent = '稍后提醒(24h)';
        laterBtn.addEventListener('click', () => { dismissMaintenanceRemind(); close(); showToast('24小时内不再提醒', 'info'); });
        bottomBar.appendChild(keepAllBtn);
        bottomBar.appendChild(laterBtn);
        body.appendChild(bottomBar);
    }

    function renderResolved() {
        resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:0.9em;font-weight:600;border-bottom:2px solid #fab387;';
        pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        healthBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        body.innerHTML = '';

        const resolved = getMaintenanceResolved(chatId);
        if (!resolved.length) {
            body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">暂无已维护记录</div>';
            return;
        }
        for (let i = resolved.length - 1; i >= 0; i--) {
            const entry = resolved[i];
            const d = new Date(entry.resolvedAt);
            const timeStr = d.toLocaleString();
            // 展示详细操作内容
            const r = entry.results || {};
            const parts = [];
            if (r.kept) parts.push(`保留 ${r.kept} 条`);
            if (r.deleted) parts.push(`删除 ${r.deleted} 条`);
            if (r.promoted) parts.push(`升级 ${r.promoted} 条`);
            if (r.demoted) parts.push(`降级 ${r.demoted} 条`);
            if (r.compressed) parts.push(`压缩 ${r.compressed} 条`);
            const detail = parts.length ? parts.join(' · ') : `${entry.actions || 0} 条已处理`;

            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);font-size:0.85em;gap:8px;';
            row.innerHTML = `<span style="opacity:0.5;min-width:20px;">#${resolved.length - i}</span><span style="flex:1;">${escapeHtml(detail)}</span><span style="opacity:0.4;font-size:0.8em;white-space:nowrap;">${escapeHtml(timeStr)}</span>`;
            body.appendChild(row);
        }
        const clearBtn = document.createElement('button');
        clearBtn.className = 'menu_button'; clearBtn.textContent = '清空已维护'; clearBtn.style.cssText = 'margin-top:12px;';
        clearBtn.addEventListener('click', () => {
            withFeedback(clearBtn, async () => {
                clearMaintenanceResolved(chatId);
                body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">已清空</div>';
            }, { successText: '已清空' });
        });
        body.appendChild(clearBtn);
    }

    async function renderHealthCheck() {
        pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        healthBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:0.9em;font-weight:600;border-bottom:2px solid #a6e3a1;';

        body.innerHTML = '<div style="text-align:center;padding:40px;"><i class="fa-solid fa-spinner fa-spin" style="font-size:2em;"></i><p style="margin-top:12px;opacity:0.6;">正在体检...</p></div>';

        try {
            const healthResult = await runHealthCheck(chatId);
            body.innerHTML = '';
            body.appendChild(buildHealthCheckPanel(chatId, healthResult, {
                onRefresh: renderHealthCheck,
                onAction: () => { /* 操作后无需刷新面板，单项操作后条目已移除 */ },
            }));
        } catch (e) {
            body.innerHTML = `<div style="text-align:center;padding:40px;opacity:0.6;color:#f44338;">
                <i class="fa-solid fa-circle-exclamation" style="font-size:2em;"></i>
                <p style="margin-top:12px;">体检异常: ${escapeHtml(e.message)}</p>
            </div>`;
        }
    }

    pendingBtn.addEventListener('click', renderPending);
    resolvedBtn.addEventListener('click', renderResolved);
    healthBtn.addEventListener('click', renderHealthCheck);
    renderPending();
}

// ═══════════════════════════════════════════════════════════
//  斜杠命令
// ═══════════════════════════════════════════════════════════

function registerSlashCommands() {
    const ctx = SillyTavern.getContext();
    const addCmd = (name, callback, helpText) => {
        try {
            if (typeof ctx.SlashCommandParser?.addCommandObject === 'function') {
                ctx.SlashCommandParser.addCommandObject({
                    name, callback,
                    aliases: [],
                    helpText: helpText || '',
                    returns: '',
                });
            } else if (typeof ctx.registerSlashCommand === 'function') {
                ctx.registerSlashCommand(name, callback, [], helpText);
            }
        } catch (e) {
            console.warn(`[BB-Memory] 注册命令 ${name} 失败:`, e.message);
        }
    };

    addCmd('bb-init', async (args) => {
        showExternalInitializerNotice();
    }, '提示使用外置 HTML 转化工具进行 BB-Memory 初始化');

    addCmd('bb-backup', async (args = '') => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await exportMemoriesToChatMetadata(chatId);
        if (result.skipped) {
            showToast(`备份已跳过：${(result.size / 1024).toFixed(1)}KB 超过上限 ${(result.limit / 1024).toFixed(0)}KB，请使用本地 JSON 导出`, 'warning');
        } else {
            showToast(`备份完成：${result.count} 条文本/引用 (${(result.size / 1024).toFixed(1)}KB)，不内联向量`, 'success');
        }
    }, '手动备份记忆文本到服务器；向量请在存档页使用云端向量槽');

    addCmd('bb-restore', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await importMemoriesFromChatMetadata(chatId);
        const vectorTip = result.vectorImported ? `，向量 ${result.vectorImported} 条` : '';
        showToast(`恢复：${result.restored} 新增，${result.skipped} 跳过${vectorTip}`, 'success');
    }, '从服务器恢复记忆');

    addCmd('bb-stats', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const stats = await getMemoryStats(chatId);
        const msg = `BB-Memory 统计：\nNPC: ${stats.npc.total} | 物品: ${stats.items.total} | 里程碑: ${stats.milestones?.total || 0} | 时间线: ${stats.timeline?.total || 0} | 记忆: ${stats.memories.total} | 实时: ${stats.realtime?.total || 0}`;
        showToast(msg, 'info');
    }, '查看记忆统计');

    addCmd('bb-manage', () => {
        const chatId = getChatId();
        if (!chatId) return;
        openAssistant(chatId, 'dashboard');
    }, '打开记忆管家面板');

    addCmd('bb-rescue', () => {
        openSlotRescuePanel().catch(e => showToast(`打开存档救援失败: ${e.message}`, 'error'));
    }, '打开存档救援 — 找回因角色下标变化而失联的历史存档');

    addCmd('bb-maintenance', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        try {
            const result = await checkMaintenanceNeeded(chatId);
            showMaintenancePopup(chatId, result);
        } catch (e) {
            console.warn('[BB-Memory] 维护检查异常:', e.message);
            showToast('维护检查出错: ' + e.message, 'error');
            showMaintenancePopup(chatId, { issues: [], issueCount: 0, totalItems: 0, needed: false });
        }
    }, '打开记忆维护面板');

    addCmd('bb-clear', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const confirmed = await new Promise(resolve => {
            if (typeof ctx.callPopup === 'function') {
                ctx.callPopup('[BB-Memory] 确定要清空所有记忆数据吗？此操作不可恢复。', 'confirm').then(r => resolve(r));
            } else {
                resolve(confirm('确定要清空所有记忆数据吗？'));
            }
        });
        if (confirmed) {
            await clearAllData(chatId);
            showToast('所有记忆已清空', 'warning');
        }
    }, '清空当前聊天的所有记忆');

    addCmd('bb-delete-floor', async (args) => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const floor = parseInt(args, 10);
        if (isNaN(floor)) { showToast('用法: /bb-delete-floor <楼层号>', 'warning'); return; }
        // 查找该楼层 AI 消息的 exchange hash
        const ctx2 = SillyTavern.getContext();
        const chat = ctx2.chat || [];
        if (floor < 0 || floor >= chat.length) { showToast(`楼层 ${floor} 不存在`, 'warning'); return; }
        const msg = chat[floor];
        if (!msg || msg.is_user) { showToast(`第 ${floor} 层不是AI消息`, 'warning'); return; }
        // 查找前一条用户消息，计算 exchange hash
        let userMsg = '';
        for (let j = floor - 1; j >= 0; j--) {
            if (chat[j].is_user && chat[j].mes) { userMsg = chat[j].mes; break; }
        }
        const { computeExchangeHash, unmarkExchangeProcessed, refreshExtractionMarkers } = await import('./message-state.js');
        const exchangeHash = computeExchangeHash(userMsg, msg.mes || '');
        const result = await deleteByExchange(chatId, exchangeHash, buildFloorDeleteOptions(chatId, msg, floor));
        await unmarkExchangeProcessed(chatId, exchangeHash);
        const deletedTotal = Object.values(result.deleted || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
        const restoredTotal = Object.values(result.restored || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
        msg._bbmem_extracted = false;
        msg._bbmem_skipped = false;
        msg._bbmem_pendingExtraction = true;
        try { ctx2.saveChatDebounced(); } catch {}
        refreshExtractionMarkers();
        showToast(`已处理楼层关联数据：删除 ${deletedTotal} / 回滚 ${restoredTotal}（NPC${result.npc}/物品${result.items}/里程碑${result.milestones || 0}/时间线${result.timeline || 0}/地点${result.map || 0}/记忆${result.memories}）`, 'success');
    }, '删除指定楼层的所有关联记忆');

    addCmd('bb-re-extract', async (args) => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const floor = parseInt(args, 10);
        if (isNaN(floor)) { showToast('用法: /bb-re-extract <楼层号>', 'warning'); return; }
        const ctx2 = SillyTavern.getContext();
        const chat = ctx2.chat || [];
        if (floor < 0 || floor >= chat.length) { showToast(`楼层 ${floor} 不存在`, 'warning'); return; }
        const aiMsg = chat[floor];
        if (!aiMsg || aiMsg.is_user) { showToast(`第 ${floor} 层不是AI消息`, 'warning'); return; }
        // 向前查找用户消息配对
        let userMsg = '';
        for (let j = floor - 1; j >= 0; j--) {
            if (chat[j].is_user && chat[j].mes) { userMsg = chat[j].mes; break; }
        }
        // 先删除旧记忆，再重新提取
        const { computeExchangeHash } = await import('./message-state.js');
        const exchangeHash = computeExchangeHash(userMsg, aiMsg.mes || '');
        await deleteByExchange(chatId, exchangeHash, buildFloorDeleteOptions(chatId, aiMsg, floor));
        await unmarkExchangeProcessed(chatId, exchangeHash); // v6.1.6
        // 清除提取标记以便重新提取
        aiMsg._bbmem_extracted = false;
        aiMsg._bbmem_pendingExtraction = true;
        try { ctx2.saveChatDebounced(); } catch {}
        // 触发提取
        showToast(`正在重新提取第 ${floor} 层...`, 'info');
        try {
            await reextractFloor(chatId, floor, { mode: 'retry' });
            showToast(`第 ${floor} 层重新提取完成`, 'success');
        } catch (error) {
            showToast(`第 ${floor} 层重新提取失败：${error.message || '未知错误'}`, 'error');
        }
    }, '删除并重新提取指定楼层的记忆');

    addCmd('bb-floor-refresh', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const stats = await refreshAllSourceFloors(chatId);
        const total = stats.npc + stats.items + stats.timeline + stats.memories;
        if (total === 0) {
            showToast('当前没有需要刷新的楼层记忆（所有记忆已标记为旧聊天来源）', 'info');
        } else {
            showToast(`楼层刷新完成！已标记 ${total} 条记忆为旧聊天来源（NPC:${stats.npc} 物品:${stats.items} 里程碑:${stats.milestones || stats.timeline} 记忆:${stats.memories}）`, 'success');
        }
    }, '换楼刷新 — 将所有记忆的楼层标记为旧聊天来源（开新聊天后使用）');

    addCmd('bb-clue', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const { openClueBoard } = await import('./clue-board.js');
        openClueBoard(chatId);
    }, '打开线索板 — 追踪线索、创建连线推理');

    addCmd('bb-map', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const { openMapView } = await import('./map-view.js');
        openMapView(chatId);
    }, '打开世界地图 — 管理地点和路径');

    addCmd('bb-agent', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        showToast('正在打开 Agent 测试版；实验功能可能执行写操作，建议先备份。', 'warning');
        const { openAgent } = await import('./memory-agent.js');
        openAgent(chatId);
    }, '测试功能：打开记忆管家 Agent（实验功能，可能执行写操作，建议备份后使用）');

    if (getSettings().debugLogging) {
        console.log('[BB-Memory] 斜杠命令已注册');
    }
}

// ═══════════════════════════════════════════════════════════
//  事件处理
// ═══════════════════════════════════════════════════════════

function runWhenIdle(task, timeout = 10000) {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => task(), { timeout });
        return;
    }
    setTimeout(task, 0);
}

function buildFloorDeleteOptions(chatId, msg, floor) {
    return {
        sourceFloor: Number.isInteger(floor) ? floor : undefined,
        sourceMessageHash: cyrb53Hash(msg?.mes || ''),
        sourceChatId: chatId || '',
    };
}

function countDeleteResult(result) {
    return (result.npc || 0)
        + (result.items || 0)
        + (result.milestones || 0)
        + (result.timeline || 0)
        + (result.memories || 0)
        + (result.map || 0);
}

async function onChatChanged() {
    chatSwitchSuppressDeletesUntil = Date.now() + 5000;
    clearPendingDeletionChecks('chat-switch');
    clearInjection();
    lastRetrievalResult = null;

    const chatId = getChatId();
    if (!chatId) return;
    const charId = getCharacterId();
    const prevChatId = lastObservedChatId;
    const prevCharId = lastObservedCharId;
    lastObservedChatId = chatId;
    lastObservedCharId = charId;

    const settings = getSettings();

    // 迁移检查
    if (!settings.migratedFromV4) {
        try { await migrateV4ToV5(chatId); } catch { /* ignore */ }
    }

    // v9.3.1 存档命名空间救援：必须在任何存档读写之前完成，
    // 否则会在空的稳定命名空间上继续操作，用户看到的就是"存档消失"。
    try {
        await primeIdentityCache(charId);
        await runSlotRescueOnLoad(charId);
    } catch (e) {
        console.warn('[BB-Memory] 存档救援检查失败:', e.message || e);
    }

    // 可见性同步
    setTimeout(() => {
        syncMessageVisibility().catch(() => {});
        refreshExtractionMarkers();
        refreshExtractionFloorStatus();
    }, 800);

    // v7.8.0 加载 per-chat 日历描述到 UI
    (async () => {
        const calTextarea = document.querySelector('#bb_calendar_description');
        if (calTextarea) {
            const val = await getCalendarDescription(chatId);
            calTextarea.value = val || '';
        }
    })();

    // 维护提醒：延后到空闲时段，避免聊天刚加载时抢主线程。
    setTimeout(async () => {
        runWhenIdle(async () => {
            try {
                const result = await checkMaintenanceNeeded(chatId);
                if (result.needed) {
                    showToast(`记忆维护提醒：${result.issueCount} 条待处理。输入 /bb-maintenance 查看`, 'warning');
                }
            } catch { /* ignore */ }
        });
    }, 10000);

    // 跨设备恢复：延后到空闲时段，避免大备份解析影响聊天加载。
    if (settings.autoBackupEnabled) {
        setTimeout(async () => {
            runWhenIdle(async () => {
                try {
                    const result = await importMemoriesFromChatMetadata(chatId);
                    if (result.restored > 0 && settings.debugLogging) {
                        console.log(`[BB-Memory] 自动恢复: ${result.restored} 条`);
                    }
                } catch { /* ignore */ }
            }, 15000);
        }, 15000);
    }

    setTimeout(() => {
        maybePromptChatSwitchSlot({ prevChatId, prevCharId, chatId, charId }).catch((e) => {
            console.warn('[BB-Memory] 切换窗口存档提示失败:', e.message || e);
        });
    }, 1200);
}

function initChatSwitchFallbackWatch() {
    if (chatSwitchFallbackTimer) return;
    chatSwitchFallbackTimer = setInterval(() => {
        const chatId = getChatId();
        if (!chatId) return;
        const charId = getCharacterId();
        const sameChat = String(chatId) === String(lastObservedChatId || '');
        const sameChar = String(charId || '') === String(lastObservedCharId || '');
        if (sameChat && sameChar) return;
        if (chatSwitchFallbackRunning) return;

        chatSwitchFallbackRunning = true;
        onChatChanged()
            .catch((e) => console.warn('[BB-Memory] 聊天切换兜底检测失败:', e.message || e))
            .finally(() => { chatSwitchFallbackRunning = false; });
    }, 1500);
}

function onNewMessage() {
    if (!getSettings().autoGenEnabled) {
        syncMessageVisibility().catch(() => {});
    }
    setTimeout(() => {
        refreshExtractionMarkers();
        refreshExtractionFloorStatus();
    }, 300);
}

// ═══════════════════════════════════════════════════════════
//  悬浮球 (Floating Action Hub) —— v4.4.2 移植
// ═══════════════════════════════════════════════════════════

function renderHubHitItem(h, typeIcons, levelColors, dimmed) {
    const icon = typeIcons[h.type] || 'fa-circle';
    const color = levelColors[h.level] || '#888';
    const scorePct = Math.round(h.score * 100);
    const shortTitle = (h.title || '').length > 14
        ? escapeHtml(h.title.slice(0, 14)) + '...'
        : escapeHtml(h.title);
    const opacityStyle = dimmed ? 'opacity:0.55;' : '';
    return `<div class="bb-hub-hit-item" title="${escapeHtml(h.title)}" style="${opacityStyle}">
        <i class="fa-solid ${icon}" style="color:${color};font-size:0.7em;"></i>
        <span class="bb-hub-hit-title">${shortTitle}</span>
        <span class="bb-hub-hit-level" style="color:${color}">${h.level}</span>
        <span class="bb-hub-hit-score">${scorePct}%</span>
    </div>`;
}

function renderEternalInjectionNote(count) {
    const n = Number(count || 0);
    if (n <= 0) return '';
    return `<div class="bb-hit-eternal-note">
        <i class="fa-solid fa-infinity"></i> 永恒记忆 ${n} 条已全部注入，未计入普通命中列表
    </div>`;
}

function getMilestoneHitGroups(result = lastRetrievalResult) {
    const hits = result?.milestoneHits || {};
    if (Array.isArray(hits)) return { foreshadow: [], ongoing: [], ended: hits };
    if (hits && typeof hits === 'object') {
        return {
            foreshadow: Array.isArray(hits.foreshadow) ? hits.foreshadow : [],
            ongoing: Array.isArray(hits.ongoing) ? hits.ongoing : [],
            ended: Array.isArray(hits.ended) ? hits.ended : [],
        };
    }
    return { foreshadow: [], ongoing: [], ended: [] };
}

function getRetrievalHitTotal(result = lastRetrievalResult) {
    if (!result) return 0;
    const milestoneHits = getMilestoneHitGroups(result);
    const tlCount = (milestoneHits.foreshadow?.length || 0)
        + (milestoneHits.ongoing?.length || 0)
        + (milestoneHits.ended?.length || 0);
    return (result.hits?.length || 0)
        + (result.npcHits?.length || 0)
        + (result.itemHits?.length || 0)
        + (result.mapHits?.length || 0)
        + (Array.isArray(result.timelineHits) ? result.timelineHits.length : 0)
        + tlCount;
}

function renderHitGroup(label, icon, countLabel, html, options = {}) {
    const openAttr = options.open ? ' open' : '';
    const emptyText = options.emptyText || '暂无';
    return `<details class="bb-hit-group"${openAttr}>
        <summary class="bb-hit-group-summary">
            <span><i class="fa-solid ${icon}"></i> ${escapeHtml(label)}</span>
            <span class="bb-hit-group-count">${escapeHtml(countLabel)}</span>
        </summary>
        <div class="bb-hit-group-list">${html || `<div class="bb-hub-hit-item bb-hub-hit-empty">${escapeHtml(emptyText)}</div>`}</div>
    </details>`;
}

async function renderHubHitList(listEl, chatId) {
    const result = lastRetrievalResult;
    const typeIcons = { fact: 'fa-lightbulb', event: 'fa-film', emotion: 'fa-heart', habit: 'fa-repeat' };
    const levelColors = { L4: '#ce93d8', L3: '#4fc3f7', L2: '#ffb74d', L1: '#9e9e9e' };
    const tierColors = { core: '#ce93d8', important: '#4fc3f7', minor: '#ffb74d', background: '#9e9e9e', key: '#ce93d8', equipped: '#4fc3f7', clue: '#ffb74d', consumable: '#9e9e9e' };

    if (!result) {
        listEl.innerHTML = '<div class="bb-hub-hit-item bb-hub-hit-empty">暂无本轮命中</div>';
        return;
    }

    const memoryHtml = (result.hits || []).map(h => renderHubHitItem(h, typeIcons, levelColors, false)).join('');
    const npcHtml = (result.npcHits || []).map(n => {
        const color = tierColors[n.npcTier] || '#888';
        return `<div class="bb-hub-hit-item" title="${escapeHtml(n.name)}">
            <i class="fa-solid fa-user" style="color:${color};font-size:0.7em;"></i>
            <span class="bb-hub-hit-title">${escapeHtml(n.name)}</span>
            <span class="bb-hub-hit-level" style="color:${color}">${n.npcTier || ''}</span>
        </div>`;
    }).join('');
    const itemHtml = (result.itemHits || []).map(i => {
        const color = tierColors[i.itemTier] || '#888';
        return `<div class="bb-hub-hit-item" title="${escapeHtml(i.name)}">
            <i class="fa-solid fa-box" style="color:${color};font-size:0.7em;"></i>
            <span class="bb-hub-hit-title">${escapeHtml(i.name)}</span>
            <span class="bb-hub-hit-level" style="color:${color}">${i.itemTier || ''}</span>
        </div>`;
    }).join('');
    const mapHtml = (result.mapHits || []).map(loc => `<div class="bb-hub-hit-item" title="${escapeHtml(loc.name)}">
        <i class="fa-solid fa-location-dot" style="color:#4fc3f7;font-size:0.7em;"></i>
        <span class="bb-hub-hit-title">${escapeHtml(loc.name || loc.id)}</span>
        <span class="bb-hub-hit-level" style="color:#4fc3f7">${escapeHtml(loc.region || '')}</span>
    </div>`).join('');
    const milestoneHits = getMilestoneHitGroups(result);
    const timelineAll = [
        ...(milestoneHits.foreshadow || []),
        ...(milestoneHits.ongoing || []),
        ...(milestoneHits.ended || []),
    ];
    const timelineHtml = timelineAll.map(t => {
        const isOngoing = t.status === 'ongoing';
        const isForeshadow = t.status === 'foreshadow';
        const color = isForeshadow ? '#ffb74d' : (isOngoing ? '#4fc3f7' : '#9e9e9e');
        return `<div class="bb-hub-hit-item" title="${escapeHtml(t.title)}">
            <i class="fa-solid ${isForeshadow ? 'fa-eye' : (isOngoing ? 'fa-play' : 'fa-check')}" style="color:${color};font-size:0.7em;"></i>
            <span class="bb-hub-hit-title">${escapeHtml((t.title || '').length > 14 ? t.title.slice(0, 14) + '...' : (t.title || ''))}</span>
            <span class="bb-hub-hit-level" style="color:${color}">${isForeshadow ? '伏笔' : (isOngoing ? '进行中' : '已结束')}</span>
        </div>`;
    }).join('');
    const timelineLineHtml = (Array.isArray(result.timelineHits) ? result.timelineHits : []).map(t => `
        <div class="bb-hub-hit-item" title="${escapeHtml(t.title || t.id)}">
            <i class="fa-solid fa-timeline" style="color:#81c784;font-size:0.7em;"></i>
            <span class="bb-hub-hit-title">${escapeHtml((t.title || '').length > 14 ? t.title.slice(0, 14) + '...' : (t.title || ''))}</span>
            <span class="bb-hub-hit-level" style="color:#81c784">${escapeHtml(t.status || '')}</span>
        </div>`).join('');

    listEl.innerHTML = [
        renderEternalInjectionNote(result.eternalInjectedCount),
        renderHitGroup('记忆', 'fa-brain', `${result.hits?.length || 0}条`, memoryHtml),
        renderHitGroup('NPC', 'fa-user', `${result.npcHits?.length || 0}条`, npcHtml),
        renderHitGroup('物品', 'fa-box', `${result.itemHits?.length || 0}条`, itemHtml),
        renderHitGroup('地图', 'fa-map', `${result.mapHits?.length || 0}处`, mapHtml),
        renderHitGroup('里程碑', 'fa-landmark', `${timelineAll.length}条`, timelineHtml),
        renderHitGroup('时间线', 'fa-timeline', `${Array.isArray(result.timelineHits) ? result.timelineHits.length : 0}条`, timelineLineHtml),
    ].join('');
}

function injectFloatingHub() {
    if (document.getElementById('bb_floating_hub')) return;

    const hub = document.createElement('div');
    hub.id = 'bb_floating_hub';
    hub.className = 'bb-floating-hub';
    hub.innerHTML = '<i class="fa-solid fa-brain"></i><span class="bb-hub-badge" id="bb_hub_badge" style="display:none;">0</span>';

    // 菜单面板
    const menu = document.createElement('div');
    menu.id = 'bb_floating_menu';
    menu.className = 'bb-floating-menu';
    menu.style.display = 'none';
    menu.innerHTML = `
        <div class="bb-floating-menu-header">
            <i class="fa-solid fa-brain"></i> BB-Memory
        </div>
        <div class="bb-floating-menu-body">
            <div class="bb-floating-menu-item" id="bb_hub_slot_info">
                <i class="fa-solid fa-floppy-disk"></i>
                <span>存档：<strong>default</strong> · <strong>0</strong> 条记忆</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="quick_save">
                <i class="fa-solid fa-floppy-disk"></i>
                <span>快速保存</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" id="bb_hub_hit_info" data-action="toggle_hit_list">
                <i class="fa-solid fa-bullseye"></i>
                <span>本轮命中：<strong id="bb_hub_hit_count">-</strong> 条</span>
                <i class="fa-solid fa-chevron-down" style="margin-left:auto;font-size:0.7em;opacity:0.5;"></i>
            </div>
            <div id="bb_hub_hit_list" style="display:none;"></div>
            <div class="bb-floating-menu-item" id="bb_hub_extract_progress" style="display:flex;">
                <i class="fa-solid fa-moon"></i>
                <span id="bb_hub_extract_label">空闲</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="manual_extract">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <span>手动提取</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" id="bb_hub_retry_extract" data-action="retry_extract" style="display:none;">
                <i class="fa-solid fa-rotate-right" style="color:#ff9800;"></i>
                <span>重新提取第 <strong id="bb_hub_retry_floor">-</strong> 层</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_maintenance">
                <i class="fa-solid fa-toolbox"></i>
                <span>记忆维护</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_clue_board">
                <i class="fa-solid fa-magnifying-glass"></i>
                <span>线索板</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_map">
                <i class="fa-solid fa-map"></i>
                <span>地图</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_realtime">
                <i class="fa-solid fa-bolt" style="color:#4db6ac;"></i>
                <span>实时记忆</span>
                <span class="bb-hub-count-badge" id="bb_hub_realtime_count">0</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_manager">
                <i class="fa-solid fa-gear"></i>
                <span>记忆管理</span>
            </div>
        </div>
    `;

    hub.appendChild(menu);
    document.body.appendChild(hub);

    // 拖拽逻辑
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let hasMoved = false;

    hub.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = hub.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        hub.style.transition = 'none';
        e.preventDefault();
    });

    hub.addEventListener('touchstart', (e) => {
        dragging = true;
        hasMoved = false;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        const rect = hub.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        hub.style.transition = 'none';
    }, { passive: false });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        let newLeft = startLeft + dx;
        let newTop = startTop + dy;
        newLeft = Math.max(0, Math.min(window.innerWidth - hub.offsetWidth, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, newTop));
        hub.style.left = newLeft + 'px';
        hub.style.top = newTop + 'px';
    });

    document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        let newLeft = startLeft + dx;
        let newTop = startTop + dy;
        newLeft = Math.max(0, Math.min(window.innerWidth - hub.offsetWidth, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, newTop));
        hub.style.left = newLeft + 'px';
        hub.style.top = newTop + 'px';
    }, { passive: false });

    const endDrag = () => {
        dragging = false;
        hub.style.transition = '';
    };
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);

    // 点击展开菜单
    hub.addEventListener('click', (e) => {
        if (hasMoved) { e.preventDefault(); e.stopPropagation(); return; }
        if (menu.contains(e.target)) return;
        toggleFloatingMenu();
    });

    // 菜单项点击
    menu.addEventListener('click', async (e) => {
        const actionItem = e.target.closest('.bb-floating-menu-action');
        if (!actionItem) return;
        const action = actionItem.dataset.action;
        await handleFloatingMenuAction(action);
        if (action !== 'toggle_hit_list' && action !== 'toggle_visibility') {
            menu.style.display = 'none';
        }
    });

    // 点击其他区域关闭菜单
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== hub && !hub.contains(e.target)) {
            menu.style.display = 'none';
        }
    });

    // 定期更新
    setInterval(() => refreshFloatingHubData(), 5000);
}

let floatingMenuVisible = false;
function toggleFloatingMenu() {
    const menu = document.getElementById('bb_floating_menu');
    const hub = document.getElementById('bb_floating_hub');
    if (!menu || !hub) return;
    floatingMenuVisible = !floatingMenuVisible;
    if (floatingMenuVisible) {
        const hubRect = hub.getBoundingClientRect();
        const menuWidth = 320;
        const menuMaxHeight = 320;
        const gap = 56;
        const edgeMargin = 16;

        if (hubRect.right + menuWidth > window.innerWidth - edgeMargin) {
            menu.style.left = 'auto';
            menu.style.right = '0';
        } else {
            menu.style.right = 'auto';
            menu.style.left = '0';
        }

        if (hubRect.top - menuMaxHeight - gap < edgeMargin) {
            menu.style.bottom = 'auto';
            menu.style.top = gap + 'px';
        } else {
            menu.style.top = 'auto';
            menu.style.bottom = gap + 'px';
        }

        menu.style.display = 'block';
        refreshFloatingHubData();
    } else {
        menu.style.display = 'none';
    }
}

async function refreshFloatingHubData() {
    const hitCountEl = document.getElementById('bb_hub_hit_count');
    if (hitCountEl) {
        // v8.2.3 显示当次检索实时命中数，而非历史累积 hitCount
        const r = lastRetrievalResult;
        if (r && r.timestamp) {
            hitCountEl.textContent = String(getRetrievalHitTotal(r));
        } else {
            hitCountEl.textContent = '-';
        }
    }
    // v8.2.1 提取失败重试按钮 & 进度文字
    const retryItem = document.getElementById('bb_hub_retry_extract');
    const retryFloor = document.getElementById('bb_hub_retry_floor');
    const extractLabel = document.getElementById('bb_hub_extract_label');
    const extractRow = document.getElementById('bb_hub_extract_progress');
    // 需要动态 import 获取最新 lastExtractFailedFloor 值
    try {
        const { lastExtractFailedFloor: failedFloor } = await import('./auto-generator.js');
        if (retryItem && retryFloor) {
            if (failedFloor !== null && failedFloor !== undefined) {
                retryItem.style.display = 'flex';
                retryFloor.textContent = String(failedFloor);
            } else {
                retryItem.style.display = 'none';
            }
        }
        if (extractLabel && !extractRow?.dataset.busy) {
            extractLabel.textContent = (failedFloor !== null && failedFloor !== undefined)
                ? `失败-第${failedFloor}层`
                : formatHubIdleStatus(getExtractionFloorStatus());
        }
    } catch { /* ignore */ }

    // v7.9.0 红点角标由提取失败控制，此处不做更新

    // 更新存档信息
    const slotInfo = document.getElementById('bb_hub_slot_info');
    if (slotInfo) {
        try {
            const chatId = getChatId();
            if (chatId) {
                const mems = await getMemories(chatId);
                const settings = getSettings();
                const slotName = settings.currentSlotName || 'default';
                slotInfo.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> <span>存档：<strong>${escapeHtml(slotName)}</strong> · <strong>${mems.length}</strong> 条记忆</span>`;
            }
        } catch { /* ignore */ }
    }

    // v9.3.3 第五柱入口徽标：只统计仍会参与注入/待结算的场景细节。
    const realtimeCount = document.getElementById('bb_hub_realtime_count');
    if (realtimeCount) {
        try {
            const chatId = getChatId();
            const entries = chatId && getSettings().realtimeEnabled !== false ? await getRealtimeMemories(chatId) : [];
            const visibleCount = entries.filter(entry => entry.settleState !== 'settled' && !entry.promotedTo).length;
            realtimeCount.textContent = String(visibleCount);
            realtimeCount.title = `当前有 ${visibleCount} 条实时场景细节会参与注入或等待结算`;
        } catch {
            realtimeCount.textContent = '-';
        }
    }

    // 更新可见性按钮图标（三态）
    const toggleItem = document.querySelector('.bb-floating-menu-action[data-action="toggle_visibility"] i');
    if (toggleItem) {
        const mode = getSettings().extractedMsgDisplay || 'hidden';
        if (mode === 'visible') toggleItem.className = 'fa-solid fa-eye';
        else if (mode === 'transparent') toggleItem.className = 'fa-solid fa-eye';
        else toggleItem.className = 'fa-solid fa-eye-slash';
    }

    // 命中列表展开时同步刷新
    const hitList = document.getElementById('bb_hub_hit_list');
    if (hitList && hitList.style.display !== 'none') {
        const chatId = getChatId();
        if (chatId) renderHubHitList(hitList, chatId);
    }
}

function cycleExtractedVisibility() {
    const settings = getSettings();
    const current = settings.extractedMsgDisplay || 'hidden';
    const next = current === 'hidden' ? 'transparent' : current === 'transparent' ? 'visible' : 'hidden';

    // 更新设置
    updateSettings({ extractedMsgDisplay: next });
    applyExtractedVisibilityClass(next);

    // 刷新 DOM 标记以应用新模式
    refreshExtractionMarkers();

    // 更新悬浮球图标
    const toggleItem = document.querySelector('.bb-floating-menu-action[data-action="toggle_visibility"] i');
    if (toggleItem) {
        toggleItem.className = next === 'hidden' ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    }

    const labels = { hidden: '楼层已隐藏', transparent: '楼层半透明显示（可区分）', visible: '楼层完全可见' };
    showToast(labels[next], 'info');
}

async function handleFloatingMenuAction(action) {
    const chatId = getChatId();
    switch (action) {
        case 'toggle_visibility': {
            cycleExtractedVisibility();
            return;  // 不关闭菜单
        }
        case 'meta_last': {
            const ctx = SillyTavern.getContext();
            const chat = ctx.chat;
            if (!chat || chat.length < 2) {
                showToast('聊天消息不足', 'warning');
                return;
            }
            let aiIdx = -1;
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i].is_user && !chat[i].is_system) { aiIdx = i; break; }
            }
            if (aiIdx === -1) { showToast('未找到 AI 消息', 'warning'); return; }
            await toggleMetaMarkerForMessage(chat, aiIdx);
            break;
        }
        case 'manual_extract': {
            if (!chatId) return;
            const menu = document.getElementById('bb_floating_menu');
            if (menu) { menu.style.display = 'none'; floatingMenuVisible = false; }
            const range = await promptFloorRange();
            if (range === null) return;
            showToast('正在提取记忆...', 'info');
            try {
                await handleInitMemory(chatId, range);
                refreshSidebar();
            } catch (e) {
                showToast(`提取失败: ${e.message}`, 'error');
            }
            break;
        }
        // v8.2.1 重新提取失败楼层
        case 'retry_extract': {
            if (!chatId) return;
            try {
                const { lastExtractFailedFloor: floor } = await import('./auto-generator.js');
                if (floor !== null && floor !== undefined) {
                    const ctx = SillyTavern.getContext();
                    const chat = ctx.chat;
                    if (chat && chat[floor]) {
                        chat[floor]._bbmem_extracted = false;
                        chat[floor]._bbmem_skipped = false;
                        chat[floor]._bbmem_pendingExtraction = true;
                    }
                    showToast(`正在重新提取第 ${floor} 层...`, 'info');
                    await reextractFloor(chatId, floor, { mode: 'retry' });
                    showToast(`第 ${floor} 层重新提取完成`, 'success');
                }
            } catch (e) {
                showToast(`重新提取失败: ${e.message}`, 'error');
            }
            break;
        }
        case 'open_clue_board': {
            if (chatId) {
                import('./clue-board.js').then(m => m.openClueBoard(chatId));
            }
            break;
        }
        case 'open_map': {
            if (chatId) {
                import('./map-view.js').then(m => m.openMapView(chatId));
            }
            break;
        }
        case 'open_realtime': {
            if (chatId) openAssistant(chatId, 'realtime');
            break;
        }
        case 'open_manager': {
            if (chatId) openMemoryManager(chatId);
            break;
        }
        case 'quick_save': {
            if (!chatId) return;
            try {
                const charId = getCharacterId();
                if (!charId) { showTopNotification('无法获取角色ID', 'error'); break; }
                // v9.3.1 写入目标必须是本窗口的**实际绑定**，不能用全局 currentSlotName。
                // 后者是上一个窗口留下的值，会造成跨窗口串档。
                const slotName = getBoundSlotName(charId, chatId);
                if (!slotName) {
                    showTopNotification(
                        '当前窗口还没有绑定存档，已阻止保存以避免覆盖其它存档。请在记忆管理的存档页选择或新建一个存档。',
                        'warning',
                    );
                    break;
                }
                const result = await saveToSlot(charId, chatId, slotName, { expectChatId: chatId });
                const count = typeof result === 'object' ? result.count : result;
                const cloudTip = result?.cloudSynced ? '，云端索引已更新（完整数据保留在本地）' : '（本地已保存，云端索引不可用）';
                showTopNotification(`已保存 ${count} 条到「${slotName}」${cloudTip}`, result?.cloudSynced ? 'success' : 'warning');
                setTimeout(() => refreshFloatingHubData(), 300);
            } catch (e) {
                showTopNotification(`快速保存失败: ${e.message}`, 'error');
            }
            break;
        }
        case 'open_maintenance': {
            if (!chatId) return;
            try {
                const result = await checkMaintenanceNeeded(chatId);
                showMaintenancePopup(chatId, result);
            } catch (e) {
                console.warn('[BB-Memory] 维护检查异常:', e.message);
                showMaintenancePopup(chatId, { issues: [], issueCount: 0, totalItems: 0, needed: false });
            }
            break;
        }
        case 'toggle_hit_list': {
            const hitList = document.getElementById('bb_hub_hit_list');
            const hitRow = document.getElementById('bb_hub_hit_info');
            if (!hitList || !hitRow) return;
            const chevron = hitRow.querySelector('.fa-chevron-down, .fa-chevron-up');
            if (hitList.style.display === 'none') {
                renderHubHitList(hitList, chatId);
                hitList.style.display = '';
                if (chevron) {
                    chevron.className = 'fa-solid fa-chevron-up';
                    chevron.style.cssText = 'margin-left:auto;font-size:0.7em;opacity:0.5;';
                }
            } else {
                hitList.style.display = 'none';
                if (chevron) {
                    chevron.className = 'fa-solid fa-chevron-down';
                    chevron.style.cssText = 'margin-left:auto;font-size:0.7em;opacity:0.5;';
                }
            }
            return;
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  初始化
// ═══════════════════════════════════════════════════════════

async function init() {
    console.log('[BB-Memory] v9.3.3 初始化开始...');

    // 确保默认设置
    getSettings();
    applyExtractedVisibilityClass();
    lastObservedChatId = getChatId();
    lastObservedCharId = getCharacterId();
    cleanupChatMetadataBloat().then(result => {
        if (result?.removed && getSettings().debugLogging) {
            console.log(`[BB-Memory] Cleaned ${result.removed} legacy slot payload(s) from chatMetadata (${(result.size / 1024).toFixed(1)}KB).`);
        }
    }).catch(() => {});

    // 挂载设置面板
    try {
        const folder = getExtensionFolder();
        const ctx = SillyTavern.getContext();
        if (typeof ctx.renderExtensionTemplateAsync === 'function') {
            const html = await Promise.race([
                ctx.renderExtensionTemplateAsync(folder, 'settings'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('模板加载超时(8s)')), 8000))
            ]);
            await mountExtensionSettingsHtml(html);
            reorderSettingsSections();
            restoreApiSettings(getSettings());
            bindSidebarEvents();
            initCollapsibleSettings();
            settingsPanelMounted = true;
        }
    } catch (e) {
        console.warn('[BB-Memory] 设置面板挂载失败:', e.message);
    }

    // 初始化自动生成器
    if (getSettings().autoGenEnabled) {
        initAutoGenerator();
    }

    // 进度回调（同步悬浮球 + 侧边栏）
    setAutoExtractProgressCallback((info) => {
        if (getSettings().debugLogging) {
            console.log(`[BB-Memory] 提取进度: ${info.phase} ${info.current}/${info.total}${info.text ? ' - ' + info.text : ''}`);
        }
        const isFailed = info.state === 'failed' || (info.current >= info.total && info.total > 0 && /失败|错误/.test(info.text || ''));
        const isDone = info.state === 'done' || isFailed || (!info.state && info.current >= info.total && info.total > 0);
        const hubLabelText = formatExtractionProgressLabel(info, true);
        const sidebarLabelText = formatExtractionProgressLabel(info, false);
        const taskKey = info.taskId || `legacy_${info.mode || 'auto'}`;

        // 同步悬浮球进度 + v7.9.0 失败红点
        const hubRow = document.getElementById('bb_hub_extract_progress');
        const badge = document.getElementById('bb_hub_badge');
        if (hubRow) {
            const icon = hubRow.querySelector('i');
            const labelEl = document.getElementById('bb_hub_extract_label');
            hubRow.dataset.taskId = taskKey;
            if (isDone) {
                hubRow.dataset.busy = isFailed ? 'failed' : 'result';
                if (icon) {
                    icon.className = isFailed ? 'fa-solid fa-exclamation-triangle' : 'fa-solid fa-check-circle';
                    icon.style.color = isFailed ? '#f44336' : '#4caf50';
                }
                if (labelEl) labelEl.textContent = hubLabelText;
                // 失败时显示红点
                if (badge) {
                    badge.textContent = '';
                    badge.style.display = isFailed ? 'block' : 'none';
                    badge.style.minWidth = isFailed ? '12px' : '';
                    badge.style.height = isFailed ? '12px' : '';
                    badge.style.borderRadius = isFailed ? '50%' : '';
                }
            } else if (info.phase) {
                hubRow.dataset.busy = '1';
                if (icon) { icon.className = 'fa-solid fa-spinner fa-spin'; icon.style.color = ''; }
                if (labelEl) labelEl.textContent = hubLabelText;
                if (badge) badge.style.display = 'none';
            } else {
                delete hubRow.dataset.busy;
                if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = ''; }
                if (labelEl) labelEl.textContent = formatHubIdleStatus(getExtractionFloorStatus());
                if (badge) badge.style.display = 'none';
            }
        }

        // 同步侧边栏进度
        const sidebarRow = document.getElementById('bb_sidebar_extract_progress');
        if (sidebarRow) {
            const icon = sidebarRow.querySelector('i');
            const strong = sidebarRow.querySelector('strong');
            sidebarRow.dataset.taskId = taskKey;
            if (isDone) {
                if (icon) {
                    icon.className = isFailed ? 'fa-solid fa-exclamation-triangle' : 'fa-solid fa-check-circle';
                    icon.style.color = isFailed ? '#f44336' : '#4caf50';
                }
                if (strong) strong.textContent = sidebarLabelText;
            } else if (info.phase) {
                if (icon) { icon.className = 'fa-solid fa-spinner fa-spin'; icon.style.color = ''; }
                if (strong) strong.textContent = sidebarLabelText;
            } else {
                if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = ''; }
                if (strong) strong.textContent = '空闲';
            }
        }
        refreshExtractionFloorStatus();
        if (isDone && !isFailed) {
            setTimeout(() => {
                const currentHub = document.getElementById('bb_hub_extract_progress');
                const currentSidebar = document.getElementById('bb_sidebar_extract_progress');
                if (currentHub?.dataset.taskId === taskKey) {
                    delete currentHub.dataset.busy;
                    delete currentHub.dataset.taskId;
                    const icon = currentHub.querySelector('i');
                    if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = ''; }
                    const labelEl = document.getElementById('bb_hub_extract_label');
                    if (labelEl) labelEl.textContent = formatHubIdleStatus(getExtractionFloorStatus());
                }
                if (currentSidebar?.dataset.taskId === taskKey) {
                    delete currentSidebar.dataset.taskId;
                    const icon = currentSidebar.querySelector('i');
                    const strong = currentSidebar.querySelector('strong');
                    if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = ''; }
                    if (strong) strong.textContent = '空闲';
                }
            }, 3000);
        }
        if (isFailed) setTimeout(() => refreshFloatingHubData(), 0);

        // 同步维护面板进度（如有打开）
        const maintOverlay = document.querySelector('.bb-maint-overlay');
        if (maintOverlay) {
            const progressEl = maintOverlay.querySelector('.bb-maint-progress');
            if (progressEl) {
                if (isDone) {
                    progressEl.style.display = 'none';
                } else if (info.phase) {
                    progressEl.style.display = 'block';
                    const pct = info.total > 0 ? Math.round((info.current / info.total) * 100) : 0;
                    progressEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(sidebarLabelText || ('提取进度: ' + info.phase + ' ' + info.current + '/' + info.total + ' (' + pct + '%)'))}`;
                } else {
                    progressEl.style.display = 'none';
                }
            }
        }
    });

    // 注册命令
    registerSlashCommands();

    // 事件订阅
    try {
        const ctx = SillyTavern.getContext();
        const ev = ctx.eventSource;
        const eventTypes = ctx.eventTypes || ctx.event_types || {};

        const chatChanged = eventTypes.CHAT_CHANGED;
        if (chatChanged && ev) ev.on(chatChanged, onChatChanged);

        const msgReceived = eventTypes.MESSAGE_RECEIVED;
        if (msgReceived && ev && !getSettings().autoGenEnabled) {
            ev.on(msgReceived, onNewMessage);
        }
    } catch (e) {
        console.warn('[BB-Memory] 事件订阅失败:', e.message);
    }

    // 刷新 UI
    refreshSidebar();

    // 注入可拖拽悬浮球
    injectFloatingHub();
    initMessageDeletionWatch();
    initExtractionMarkerWatch();
    initChatSwitchFallbackWatch();
    setTimeout(async () => {
        const chatId = getChatId();
        const charId = getCharacterId();
        if (!chatId || !charId) return;
        // v9.3.1 存档救援必须先于任何绑定/加载动作
        try {
            await primeIdentityCache(charId);
            await runSlotRescueOnLoad(charId);
        } catch (e) {
            console.warn('[BB-Memory] 初始化存档救援失败:', e.message || e);
        }
        maybePromptChatSwitchSlot({ prevChatId: null, prevCharId: null, chatId, charId }).catch((e) => {
            console.warn('[BB-Memory] 初始化存档绑定同步失败:', e.message || e);
        });
    }, 1200);

    // v6.1: 监听消息删除，自动清理关联记忆
    setTimeout(() => {
        refreshExtractionMarkers();
        refreshExtractionFloorStatus();
    }, 500);

    console.log('[BB-Memory] v9.3.3 初始化完成');
}

// v6.1: MutationObserver 监听 .mes 删除事件 → 自动清理关联记忆
let extractionMarkerWatchStarted = false;
let extractionMarkerRefreshTimer = null;

function isBbMarkerNode(node) {
    if (!node || node.nodeType !== 1) return true;
    const ownClasses = ['bb-meta-toggle-btn', 'bb-extract-marker', 'bb-floor-actions', 'bb-floor-btn'];
    if (ownClasses.some(cls => node.classList?.contains(cls))) return true;
    return ownClasses.some(cls => typeof node.querySelector === 'function' && node.querySelector(`.${cls}`));
}

function nodeNeedsMarkerRefresh(node) {
    if (!node || node.nodeType !== 1 || isBbMarkerNode(node)) return false;
    if (node.classList?.contains('mes') || node.classList?.contains('mes_buttons')) return true;
    return typeof node.querySelector === 'function' && !!node.querySelector('.mes, .mes_buttons');
}

function scheduleExtractionMarkerRefresh() {
    if (extractionMarkerRefreshTimer) clearTimeout(extractionMarkerRefreshTimer);
    extractionMarkerRefreshTimer = setTimeout(() => {
        extractionMarkerRefreshTimer = null;
        refreshExtractionMarkers();
        refreshExtractionFloorStatus();
    }, 120);
}

function initExtractionMarkerWatch() {
    if (extractionMarkerWatchStarted) return;
    extractionMarkerWatchStarted = true;
    const setup = () => {
        const chatArea = document.querySelector('#chat');
        if (!chatArea) {
            setTimeout(setup, 1500);
            return;
        }
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                const nodes = [...m.addedNodes, ...m.removedNodes];
                if (nodes.length && nodes.every(node => node.nodeType !== 1 || isBbMarkerNode(node))) continue;
                if (nodes.some(nodeNeedsMarkerRefresh) || nodeNeedsMarkerRefresh(m.target)) {
                    scheduleExtractionMarkerRefresh();
                    return;
                }
            }
        });
        observer.observe(chatArea, { childList: true, subtree: true });
        scheduleExtractionMarkerRefresh();
    };
    setup();
}

let messageDeletionWatchStarted = false;

function initMessageDeletionWatch() {
    if (messageDeletionWatchStarted) return;
    messageDeletionWatchStarted = true;
    const setup = () => {
        const chatArea = document.querySelector('#chat');
        if (!chatArea) {
            setTimeout(setup, 2000);
            return;
        }
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.removedNodes) {
                    if (node.nodeType !== 1) continue;
                    // 检查被移除的元素或其子元素中是否有带 exchange hash 的 .mes
                    const mesEls = node.classList?.contains('mes') ? [node] : [];
                    if (mesEls.length === 0 && node.querySelectorAll) {
                        node.querySelectorAll('.mes[data-bb-exchange-hash]').forEach(el => mesEls.push(el));
                    }
                    for (const mesEl of mesEls) {
                        const hash = mesEl.getAttribute('data-bb-exchange-hash');
                        const messageUid = mesEl.getAttribute('data-bb-message-uid');
                        const sourceFloorRaw = mesEl.getAttribute('data-bb-source-floor');
                        const sourceFloor = sourceFloorRaw === null ? Number(mesEl.getAttribute('mesid')) : Number(sourceFloorRaw);
                        const sourceMessageHash = mesEl.getAttribute('data-bb-source-message-hash') || '';
                        const removedChatId = mesEl.getAttribute('data-bb-chat-id') || lastObservedChatId || getChatId() || '';
                        if (hash) {
                            queueMessageDeletionCheck(hash, {
                                messageUid,
                                sourceFloor: Number.isFinite(sourceFloor) ? sourceFloor : undefined,
                                sourceMessageHash,
                                chatId: removedChatId,
                            });
                        }
                    }
                }
            }
        });
        observer.observe(chatArea, { childList: true, subtree: true });
    };
    setup();
}

const pendingDeletionChecks = new Map();

function queueMessageDeletionCheck(exchangeHash, details = {}) {
    if (!exchangeHash) return;
    const key = `${details.chatId || ''}:${details.messageUid || exchangeHash}:${details.sourceFloor ?? ''}`;
    if (pendingDeletionChecks.has(key)) clearTimeout(pendingDeletionChecks.get(key));
    const timer = setTimeout(() => {
        pendingDeletionChecks.delete(key);
        handleMessageDeletedByExchange(exchangeHash, details);
    }, 350);
    pendingDeletionChecks.set(key, timer);
}

function clearPendingDeletionChecks(reason = '') {
    if (!pendingDeletionChecks.size) return;
    for (const timer of pendingDeletionChecks.values()) clearTimeout(timer);
    pendingDeletionChecks.clear();
    if (getSettings().debugLogging) {
        console.log(`[BB-Memory] 已清空挂起楼层删除检查${reason ? `: ${reason}` : ''}`);
    }
}

function isMessageUidStillLive(messageUid) {
    if (!messageUid) return false;
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        return chat.some(msg => msg?._bbmem_messageUid === messageUid);
    } catch {
        return false;
    }
}

async function handleMessageDeletedByExchange(exchangeHash, details = {}) {
    const chatId = getChatId();
    if (!chatId || !exchangeHash) return;
    if (details.chatId && String(details.chatId) !== String(chatId)) {
        if (getSettings().debugLogging) {
            console.log(`[BB-Memory] 忽略聊天切换导致的楼层移除事件: ${details.chatId} -> ${chatId}`);
        }
        return;
    }
    if (!details.chatId && Date.now() < chatSwitchSuppressDeletesUntil) {
        if (getSettings().debugLogging) {
            console.log(`[BB-Memory] 忽略聊天切换窗口内的楼层移除事件: ${exchangeHash}`);
        }
        return;
    }
    if (details.messageUid && isMessageUidStillLive(details.messageUid)) {
        if (getSettings().debugLogging) {
            console.log(`[BB-Memory] 忽略 DOM 重绘导致的楼层移除事件: ${exchangeHash}`);
        }
        return;
    }
    try {
        const removed = await deleteByExchange(chatId, exchangeHash, {
            sourceFloor: Number.isInteger(details.sourceFloor) ? details.sourceFloor : undefined,
            sourceMessageHash: details.sourceMessageHash || '',
            sourceChatId: details.chatId || chatId,
        });
        const total = countDeleteResult(removed);
        if (total > 0) {
            const deletedTotal = Object.values(removed.deleted || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
            const restoredTotal = Object.values(removed.restored || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
            console.log(`[BB-Memory] 自动清理已删除楼层的关联数据: 删除${deletedTotal}/回滚${restoredTotal} NPC${removed.npc}/物品${removed.items}/里程碑${removed.milestones || 0}/时间线${removed.timeline || 0}/地点${removed.map || 0}/记忆${removed.memories}`);
            showToast(`已自动清理 ${total} 条关联数据（删除 ${deletedTotal} / 回滚 ${restoredTotal}）`, 'info');
        }
    } catch (e) {
        console.warn('[BB-Memory] 自动清理失败:', e.message);
    }
}

function refreshSidebar() {
    // 更新侧边栏记忆计数
    const updateCount = async () => {
        const chatId = getChatId();
        if (!chatId) return;
        try {
            const stats = await getMemoryStats(chatId);
            const el = document.querySelector('#bb_memory_count');
            if (el) el.textContent = stats.memories.total;
            refreshExtractionFloorStatus();
        } catch { /* ignore */ }
    };
    updateCount();
    if (!sidebarRefreshTimer) {
        sidebarRefreshTimer = setInterval(updateCount, 30000); // 30秒刷新
    }
}

function updateSidebarHitList() {
    const result = lastRetrievalResult;
    const listEl = document.getElementById('bb_sidebar_hit_list');
    const tsEl = document.getElementById('bb_hit_timestamp');
    if (!listEl) return;

    const hasAny = result && (
        (result.hits && result.hits.length) ||
        (result.eternalInjectedCount > 0) ||
        (result.npcHits && result.npcHits.length) ||
        (result.itemHits && result.itemHits.length) ||
        (result.milestoneHits && ((getMilestoneHitGroups(result).foreshadow.length || 0) + getMilestoneHitGroups(result).ongoing.length + getMilestoneHitGroups(result).ended.length)) ||
        (Array.isArray(result.timelineHits) && result.timelineHits.length) ||
        (result.mapHits && result.mapHits.length)
    );

    if (!hasAny) {
        listEl.innerHTML = '<div style="opacity:0.4;text-align:center;font-size:0.8em;">暂无命中</div>';
        return;
    }

    if (tsEl) {
        const d = new Date(result.timestamp);
        tsEl.textContent = d.toLocaleTimeString();
    }

    const typeIcons = { fact: 'fa-lightbulb', event: 'fa-film', emotion: 'fa-heart', habit: 'fa-repeat' };
    const levelColors = { L4: '#ce93d8', L3: '#4fc3f7', L2: '#ffb74d', L1: '#9e9e9e' };
    const tierColors = { core: '#ce93d8', important: '#4fc3f7', minor: '#ffb74d', background: '#9e9e9e', key: '#ce93d8', equipped: '#4fc3f7', clue: '#ffb74d', consumable: '#9e9e9e' };

    const memoryHtml = (result.hits || []).map(h => {
        const icon = typeIcons[h.type] || 'fa-circle';
        const color = levelColors[h.level] || '#888';
        const scorePct = Math.round(h.score * 100);
        const shortTitle = (h.title || '').length > 18
            ? escapeHtml(h.title.slice(0, 18)) + '...'
            : escapeHtml(h.title);
        return `<div class="bb-hub-hit-item" title="${escapeHtml(h.title)}" style="cursor:default;">
            <i class="fa-solid ${icon}" style="color:${color};font-size:0.7em;"></i>
            <span class="bb-hub-hit-title">${shortTitle}</span>
            <span class="bb-hub-hit-level" style="color:${color}">${h.level}</span>
            <span class="bb-hub-hit-score">${scorePct}%</span>
        </div>`;
    }).join('');

    const npcHtml = (result.npcHits || []).map(n => {
        const color = tierColors[n.npcTier] || '#888';
        return `<div class="bb-hub-hit-item" title="${escapeHtml(n.name)}" style="cursor:default;">
            <i class="fa-solid fa-user" style="color:${color};font-size:0.7em;"></i>
            <span class="bb-hub-hit-title">${escapeHtml(n.name)}</span>
            <span class="bb-hub-hit-level" style="color:${color}">${n.npcTier || ''}</span>
        </div>`;
    }).join('');

    const itemHtml = (result.itemHits || []).map(i => {
        const color = tierColors[i.itemTier] || '#888';
        return `<div class="bb-hub-hit-item" title="${escapeHtml(i.name)}" style="cursor:default;">
            <i class="fa-solid fa-box" style="color:${color};font-size:0.7em;"></i>
            <span class="bb-hub-hit-title">${escapeHtml(i.name)}</span>
            <span class="bb-hub-hit-level" style="color:${color}">${i.itemTier || ''}</span>
        </div>`;
    }).join('');

    const mapHtml = (result.mapHits || []).map(loc => `<div class="bb-hub-hit-item" title="${escapeHtml(loc.name)}" style="cursor:default;">
        <i class="fa-solid fa-location-dot" style="color:#4fc3f7;font-size:0.7em;"></i>
        <span class="bb-hub-hit-title">${escapeHtml(loc.name || loc.id)}</span>
        <span class="bb-hub-hit-level" style="color:#4fc3f7">${escapeHtml(loc.region || '')}</span>
    </div>`).join('');

    const milestoneHits = getMilestoneHitGroups(result);
    const tlAll = [
        ...(milestoneHits.foreshadow || []),
        ...(milestoneHits.ongoing || []),
        ...(milestoneHits.ended || []),
    ];
    const timelineHtml = tlAll.map(t => {
        const isOngoing = t.status === 'ongoing';
        const isForeshadow = t.status === 'foreshadow';
        const color = isForeshadow ? '#ffb74d' : (isOngoing ? '#4fc3f7' : '#9e9e9e');
        return `<div class="bb-hub-hit-item" title="${escapeHtml(t.title)}" style="cursor:default;">
            <i class="fa-solid ${isForeshadow ? 'fa-eye' : (isOngoing ? 'fa-play' : 'fa-check')}" style="color:${color};font-size:0.7em;"></i>
            <span class="bb-hub-hit-title">${escapeHtml((t.title || '').length > 18 ? t.title.slice(0, 18) + '...' : (t.title || ''))}</span>
            <span class="bb-hub-hit-level" style="color:${color}">${isForeshadow ? '伏笔' : (isOngoing ? '进行中' : '已结束')}</span>
        </div>`;
    }).join('');
    const timelineLineHtml = (Array.isArray(result.timelineHits) ? result.timelineHits : []).map(t => `
        <div class="bb-hub-hit-item" title="${escapeHtml(t.title || t.id)}" style="cursor:default;">
            <i class="fa-solid fa-timeline" style="color:#81c784;font-size:0.7em;"></i>
            <span class="bb-hub-hit-title">${escapeHtml((t.title || '').length > 18 ? t.title.slice(0, 18) + '...' : (t.title || ''))}</span>
            <span class="bb-hub-hit-level" style="color:#81c784">${escapeHtml(t.status || '')}</span>
        </div>`).join('');

    listEl.innerHTML = [
        renderEternalInjectionNote(result.eternalInjectedCount),
        renderHitGroup('记忆', 'fa-brain', `${result.hits?.length || 0}条`, memoryHtml),
        renderHitGroup('NPC', 'fa-user', `${result.npcHits?.length || 0}条`, npcHtml),
        renderHitGroup('物品', 'fa-box', `${result.itemHits?.length || 0}条`, itemHtml),
        renderHitGroup('地图', 'fa-map', `${result.mapHits?.length || 0}处`, mapHtml),
        renderHitGroup('里程碑', 'fa-landmark', `${tlAll.length}条`, timelineHtml),
        renderHitGroup('时间线', 'fa-timeline', `${Array.isArray(result.timelineHits) ? result.timelineHits.length : 0}条`, timelineLineHtml),
    ].join('');
}

// ═══════════════════════════════════════════════════════════
//  全局 API（调试/控制台用）
// ═══════════════════════════════════════════════════════════

globalThis.bbMemoryExpandEntityKeyword = async function (keyword, limit = 12) {
    // v5 兼容 API：按当前聊天读取记忆后再展开实体关键词。
    const chatId = getChatId();
    if (!chatId) return [];
    const memories = await getMemories(chatId);
    return expandMemoriesForEntityKeyword(memories, keyword, { limit });
};

// v9.3.3 整理师聚类引擎调试入口（纯函数，零 API 调用）
const CURATOR_PILLAR_LOADERS = {
    mem: getMemories,
    npc: getNpcProfiles,
    item: getItems,
    milestone: getMilestones,
    timeline: getTimeline,
};

async function debugCuratorBuildGroups(pillar = 'mem', options = {}) {
    const chatId = getChatId();
    if (!chatId) {
        console.warn('[BB-Memory] 未打开聊天，无法读取数据');
        return null;
    }
    const { prepareCurationGroups, buildSimilarityMatrix } = await import('./memory-curator.js');
    const loader = CURATOR_PILLAR_LOADERS[pillar] || CURATOR_PILLAR_LOADERS.mem;
    const entries = await loader(chatId);
    const s = getSettings();
    const result = await prepareCurationGroups(chatId, pillar, entries, options.newIds || [], {
        recallPerEntry: options.recallPerEntry ?? s.aiCurateRecallPerEntry,
        clusterThreshold: options.clusterThreshold ?? s.aiCurateClusterThreshold,
        maxGroups: options.maxGroups ?? s.aiCurateMaxGroupsPerRun,
        includeArchived: options.includeArchived === true,
    });
    console.log(`[BB-Memory] 柱=${result.pillar} 条目=${result.stats.poolSize} 种子=${result.stats.seedCount} `
        + `阈值=${result.stats.clusterThreshold} 建边=${result.stats.edgeCount} 组=${result.groups.length} `
        + `向量覆盖率=${(result.stats.vectorCoverage * 100).toFixed(0)}%`);
    result.groups.forEach((group, i) => {
        console.log(`\n── 组 ${i + 1}／${result.groups.length}：${group.ids.length} 条，最高相似度 ${group.maxSimilarity.toFixed(3)}，平均 ${group.avgSimilarity.toFixed(3)}`);
        console.table(group.entries.map(entry => ({
            id: entry.id,
            标题: entry.title || entry.name || entry.event || '',
            内容: String(entry.content || entry.summary || entry.significance || '').slice(0, 40),
            故事时间: entry.storyTime || entry.st || '',
        })));
        console.table(buildSimilarityMatrix(group.entries, result.pillar));
    });
    if (!result.groups.length) console.log('[BB-Memory] 没有聚出候选组（条目太少、都不相似，或阈值偏高）');
    return result;
}

// ═══════════════════════════════════════════════════════════
//  v9.3.3 AI 记忆整理：侧边栏入口
// ═══════════════════════════════════════════════════════════

function setCurateStatus(text, tone = '') {
    const el = document.querySelector('#bb_curate_status');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = tone === 'error' ? '#f44336' : (tone === 'success' ? '#4caf50' : '');
}

function setCurateButtonsBusy(busy, activeBtn, busyText) {
    const ids = ['#bb_curate_now_btn', '#bb_curate_full_btn', '#bb_curate_undo_btn'];
    for (const id of ids) {
        const btn = document.querySelector(id);
        if (!btn) continue;
        if (busy) {
            if (!btn.dataset.bbOrigHtml) btn.dataset.bbOrigHtml = btn.innerHTML;
            btn.disabled = true;
            if (id === activeBtn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${busyText || '处理中'}`;
        } else {
            btn.disabled = false;
            if (btn.dataset.bbOrigHtml) {
                btn.innerHTML = btn.dataset.bbOrigHtml;
                delete btn.dataset.bbOrigHtml;
            }
        }
    }
}

const CURATE_THRESHOLD_LABELS = Object.freeze({
    mem: ['记忆', 'aiCurateMemThreshold'],
    npc: ['NPC', 'aiCurateNpcThreshold'],
    item: ['物品', 'aiCurateItemThreshold'],
    milestone: ['里程碑', 'aiCurateMilestoneThreshold'],
    timeline: ['时间线', 'aiCurateTimelineThreshold'],
});

/** 展示各柱累积计数与阈值，让用户知道还差多少条会自动触发整理。 */
async function refreshCurateStatus() {
    const el = document.querySelector('#bb_curate_status');
    if (!el) return;
    const s = getSettings();
    if (!s.aiCurateEnabled) { setCurateStatus('AI 整理已关闭'); return; }
    const chatId = getChatId();
    if (!chatId) { setCurateStatus('未进入对话'); return; }
    if (s.aiCurateTriggerMode === 'manual') { setCurateStatus('仅手动触发模式'); return; }
    try {
        const { getCurationState } = await import('./memory-curator.js');
        const { counters } = getCurationState(chatId, s);
        const parts = [];
        for (const [pillar, [label, key]] of Object.entries(CURATE_THRESHOLD_LABELS)) {
            const threshold = Number(s[key]);
            if (!Number.isFinite(threshold) || threshold <= 0) continue;
            const count = counters[pillar] || 0;
            if (count > 0) parts.push(`${label} ${count}/${threshold}`);
        }
        setCurateStatus(parts.length
            ? `自动整理进度：${parts.join('，')}（${s.aiCurateTriggerMode === 'all' ? '全部达标' : '任一达标'}触发）`
            : '自动整理进度：暂无新增条目');
    } catch { setCurateStatus(''); }
}

/** 全库整理开销较大，先把预估的 API 调用次数摆出来让用户确认。 */
async function confirmFullCuration(message) {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.Popup?.show?.confirm === 'function') {
            return await ctx.Popup.show.confirm('全库整理', `${message}\n\n继续吗？`);
        }
    } catch { /* 降级到原生 confirm */ }
    return confirm(`全库整理\n\n${message}\n\n继续吗？`);
}

async function handleCurateNow(fullLibrary) {
    const chatId = getChatId();
    if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
    const btnId = fullLibrary ? '#bb_curate_full_btn' : '#bb_curate_now_btn';
    const onProgress = ({ phase, message, current, total }) => {
        const prefix = { cluster: '分析', ai: 'AI 整理', apply: '应用', review: '待确认' }[phase] || '处理';
        setCurateStatus(message || prefix);
        setCurateButtonsBusy(true, btnId, total ? `${prefix} ${current}/${total}` : prefix);
    };

    setCurateButtonsBusy(true, btnId, '准备中');
    setCurateStatus('正在准备整理...');
    try {
        const { runCurationFlow, runFullLibraryCuration, isCurationRunning } = await import('./memory-curator.js');
        if (isCurationRunning()) {
            showToast('已有整理任务在运行，请稍后再试', 'warning');
            return;
        }
        if (fullLibrary) {
            const probe = await runFullLibraryCuration(chatId, { onProgress });
            if (probe.error) { showToast(probe.error, 'error'); setCurateStatus(probe.error, 'error'); return; }
            if (!probe.needsConfirm) {
                showToast(probe.summary, 'info');
                setCurateStatus(probe.summary);
                return;
            }
            setCurateButtonsBusy(false);
            if (!await confirmFullCuration(probe.summary)) {
                setCurateStatus('已取消全库整理');
                return;
            }
            setCurateButtonsBusy(true, btnId, '整理中');
            // 复用探测阶段已聚好的组，不重跑一遍全库两两比较
            const report = await runFullLibraryCuration(chatId, {
                confirmed: true, groups: probe.groups, onProgress,
            });
            showToast(report.error ? `全库整理出错：${report.error}` : report.summary,
                report.error ? 'error' : 'success');
            setCurateStatus(report.summary || report.error, report.error ? 'error' : 'success');
            return;
        }

        const report = await runCurationFlow(chatId, { source: 'manual', onProgress });
        if (report.error) {
            showToast(`AI 整理失败：${report.error}`, 'error');
            setCurateStatus(report.error, 'error');
            return;
        }
        showToast(`AI 整理：${report.summary}`, 'success');
        setCurateStatus(report.summary
            + (report.applyResult?.snapshotId ? '（可用「撤销整理」回滚）' : ''), 'success');
    } catch (e) {
        console.warn('[BB-Memory] AI 整理失败:', e);
        showToast(`AI 整理失败：${e.message}`, 'error');
        setCurateStatus(e.message, 'error');
    } finally {
        setCurateButtonsBusy(false);
    }
}

async function handleCurateUndo() {
    const chatId = getChatId();
    if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
    setCurateButtonsBusy(true, '#bb_curate_undo_btn', '撤销中');
    try {
        const { undoLastCuration } = await import('./memory-curator.js');
        const result = await undoLastCuration(chatId);
        if (!result.ok) {
            showToast(result.error, 'warning');
            setCurateStatus(result.error, 'error');
            return;
        }
        const label = result.opSummary ? `「${result.opSummary}」` : '上次整理';
        showToast(`已撤销${label}：${result.summary}`, 'success');
        setCurateStatus(`已撤销${label}：${result.summary}`, 'success');
    } catch (e) {
        showToast(`撤销失败：${e.message}`, 'error');
        setCurateStatus(e.message, 'error');
    } finally {
        setCurateButtonsBusy(false);
    }
}

// ═══════════════════════════════════════════════════════════
//  v9.3.3 实时记忆（第五柱）：侧边栏入口
// ═══════════════════════════════════════════════════════════

function setRealtimeStatus(text, tone = '') {
    const el = document.querySelector('#bb_realtime_status');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = tone === 'error' ? '#f44336' : (tone === 'success' ? '#4caf50' : '');
}

function setRealtimeButtonsBusy(busy, activeBtn, busyText) {
    for (const id of ['#bb_realtime_settle_btn', '#bb_realtime_undo_btn']) {
        const btn = document.querySelector(id);
        if (!btn) continue;
        if (busy) {
            if (!btn.dataset.bbOrigHtml) btn.dataset.bbOrigHtml = btn.innerHTML;
            btn.disabled = true;
            if (id === activeBtn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${busyText || '处理中'}`;
        } else {
            btn.disabled = false;
            if (btn.dataset.bbOrigHtml) {
                btn.innerHTML = btn.dataset.bbOrigHtml;
                delete btn.dataset.bbOrigHtml;
            }
        }
    }
}

/** 展示第五柱当前状态：活跃/待结算条数与实际注入条数。 */
async function refreshRealtimeStatus() {
    const el = document.querySelector('#bb_realtime_status');
    if (!el) return;
    const s = getSettings();
    if (!s.realtimeEnabled) { setRealtimeStatus('实时记忆已关闭'); return; }
    const chatId = getChatId();
    if (!chatId) { setRealtimeStatus('未进入对话'); return; }
    try {
        const entries = await getRealtimeMemories(chatId);
        if (!entries.length) { setRealtimeStatus('实时记忆：暂无场景细节'); return; }
        const active = entries.filter(e => e.settleState === 'active').length;
        const pending = entries.filter(e => e.settleState === 'pending_settle').length;
        const promoted = entries.filter(e => e.promotedTo).length;
        const { getRealtimeForInjection } = await import('./retriever.js');
        const preview = getRealtimeForInjection(entries, s);
        setRealtimeStatus(`实时记忆：生效 ${active} / 待结算 ${pending} / 已晋升 ${promoted}`
            + `，本轮注入 ${preview.injectedCount} 条（~${preview.tokenEstimate} tokens）`
            + (preview.truncated ? '，已截断' : ''));
    } catch { setRealtimeStatus(''); }
}

async function handleRealtimeSettle() {
    const chatId = getChatId();
    if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
    const s = getSettings();
    if (!s.realtimeEnabled) { showToast('实时记忆已关闭，请先在设置里启用', 'warning'); return; }

    setRealtimeButtonsBusy(true, '#bb_realtime_settle_btn', '结算中');
    setRealtimeStatus('正在准备结算...');
    try {
        const { settleRealtimeMemories, isSettlementRunning } = await import('./realtime-memory.js');
        if (isSettlementRunning()) { showToast('已有结算任务在运行，请稍后再试', 'warning'); return; }
        const chatLength = SillyTavern.getContext().chat?.length ?? 0;
        const report = await settleRealtimeMemories(chatId, {
            manual: true,
            currentFloor: chatLength - 1,
            onProgress: ({ message, current, total }) => {
                if (message) setRealtimeStatus(message);
                setRealtimeButtonsBusy(true, '#bb_realtime_settle_btn',
                    total ? `结算 ${current}/${total}` : '结算中');
            },
        });
        if (report.error) {
            showToast(`结算失败：${report.error}`, 'error');
            setRealtimeStatus(report.error, 'error');
            return;
        }
        showToast(`场景结算：${report.summary}`, 'success');
        setRealtimeStatus(report.summary
            + (report.applyResult?.snapshotId ? '（可用「撤销结算」回滚）' : ''), 'success');
    } catch (e) {
        console.warn('[BB-Memory] 实时记忆结算失败:', e);
        showToast(`结算失败：${e.message}`, 'error');
        setRealtimeStatus(e.message, 'error');
    } finally {
        setRealtimeButtonsBusy(false);
        refreshRealtimeStatus();
    }
}

async function handleRealtimeUndo() {
    const chatId = getChatId();
    if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
    setRealtimeButtonsBusy(true, '#bb_realtime_undo_btn', '撤销中');
    try {
        const { undoLastSettlement } = await import('./realtime-memory.js');
        const result = await undoLastSettlement(chatId);
        if (!result.ok) {
            showToast(result.error || '没有可撤销的结算记录', 'warning');
            setRealtimeStatus(result.error || '没有可撤销的结算记录', 'error');
            return;
        }
        const label = result.opSummary ? `「${result.opSummary}」` : '上次结算';
        showToast(`已撤销${label}：${result.summary}`, 'success');
        setRealtimeStatus(`已撤销${label}：${result.summary}`, 'success');
    } catch (e) {
        showToast(`撤销失败：${e.message}`, 'error');
        setRealtimeStatus(e.message, 'error');
    } finally {
        setRealtimeButtonsBusy(false);
        refreshRealtimeStatus();
    }
}

function printCuratorSelfTest(label, result) {
    console.log(`[BB-Memory] 整理师${label}自检：${result.pass ? '全部通过' : '存在失败'}`
        + `（${result.cases.filter(c => c.pass).length}/${result.cases.length}）`);
    console.table(result.cases.map(c => ({
        分类: c.group || label,
        用例: c.name,
        结果: c.pass ? 'PASS' : 'FAIL',
        期望: c.expected || '',
        实际: c.actual,
    })));
    return result;
}

/** 真实数据 + 真实 API 跑一次整理判断，只打印不写库。用于评估 AI 判断质量。 */
async function debugCuratorDryRun(pillar = 'mem', options = {}) {
    const grouped = await debugCuratorBuildGroups(pillar, options);
    if (!grouped?.groups?.length) return null;
    const { runCuration } = await import('./memory-curator.js');
    console.log('[BB-Memory] 正在调用 AI 整理（不写库）...');
    const result = await runCuration(getChatId(), grouped.groups, options);
    if (!result.ok) {
        console.error('[BB-Memory] 整理失败:', result.error);
        return result;
    }
    console.log(`[BB-Memory] ${result.apiMode} API 耗时 ${result.durationMs}ms，`
        + `${result.ops.length} 个有效操作，${result.rejected.length} 个被拦截`);
    if (result.ops.length) {
        console.table(result.ops.map(op => ({
            操作: op.op,
            柱: op.pillar,
            条目: op.ids.join(' + '),
            保留: op.keepId || '',
            需确认: op.forceConfirm ? '是' : '',
            理由: op.reason,
            系统备注: (op.notes || []).join('；'),
        })));
        result.ops.filter(op => op.result || op.results).forEach(op => {
            console.log(`── ${op.op} ${op.ids.join('+')} 的重写结果:`, op.result || op.results);
        });
    }
    if (result.rejected.length) console.warn('[BB-Memory] 被拦截:', result.rejected);
    console.log('[BB-Memory] 本次为 dry-run，未写入任何数据。');
    return result;
}

// v9.3.3 第五柱（实时记忆）调试入口
const realtimeDebug = {
    list: async () => {
        const chatId = getChatId();
        if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return []; }
        const list = await getRealtimeMemories(chatId);
        console.table(list.map(e => ({
            id: e.id,
            分类: REALTIME_KINDS[e.kind]?.label || e.kind,
            内容: e.text,
            场景: e.sceneKey,
            创建楼层: e.createdFloor,
            最近楼层: e.lastSeenFloor,
            状态: REALTIME_SETTLE_STATES[e.settleState]?.label || e.settleState,
            晋升去向: e.promotedTo ? `${e.promotedTo.pillar}:${e.promotedTo.id}` : '',
        })));
        console.log(`[BB-Memory] 实时记忆 ${list.length} 条`);
        return list;
    },
    add: async (data) => {
        const chatId = getChatId();
        if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return null; }
        const entry = Array.isArray(data)
            ? await addRealtimeMemories(chatId, data)
            : await addRealtimeMemory(chatId, data);
        console.log('[BB-Memory] 已写入实时记忆:', entry);
        return entry;
    },
    update: async (id, patch) => {
        const chatId = getChatId();
        if (!chatId) return null;
        return updateRealtimeMemory(chatId, id, patch);
    },
    remove: async (id) => {
        const chatId = getChatId();
        if (!chatId) return false;
        return removeRealtimeMemory(chatId, id);
    },
    clear: async () => {
        const chatId = getChatId();
        if (!chatId) return 0;
        const n = await clearRealtimeMemories(chatId);
        console.log(`[BB-Memory] 已清空 ${n} 条实时记忆`);
        return n;
    },
    /** 场景标识与抓取范围自检，不读库不发请求 */
    selfTest: async () => {
        const { __selfTestRealtime } = await import('./realtime-memory.js');
        return printCuratorSelfTest('实时记忆', __selfTestRealtime());
    },
    /** 当前场景状态（从现有条目反推） */
    scene: async () => {
        const chatId = getChatId();
        if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return null; }
        const { deriveSceneState } = await import('./realtime-memory.js');
        const state = deriveSceneState(await getRealtimeMemories(chatId));
        console.log('[BB-Memory] 当前场景:', state);
        return state;
    },
    /** 对指定楼层真跑一次细节抓取（会写库） */
    extract: async (floor) => {
        const chatId = getChatId();
        if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return null; }
        const chat = SillyTavern.getContext().chat || [];
        const index = Number.isFinite(Number(floor)) ? Number(floor) : chat.length - 1;
        const msg = chat[index];
        if (!msg) { console.warn(`[BB-Memory] 第 ${index} 层不存在`); return null; }
        const { extractRealtimeDetails } = await import('./realtime-memory.js');
        const result = await extractRealtimeDetails(chatId, {
            aiMessage: msg.mes || '',
            aiIndex: index,
            hash: '',
        });
        console.log('[BB-Memory] 抓取结果:', result);
        if (result.saved?.length) console.table(result.saved.map(e => ({ 分类: e.kind, 内容: e.text })));
        return result;
    },
    /** 查看注入预览（走真实的双硬上限） */
    injectionPreview: async () => {
        const chatId = getChatId();
        if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return null; }
        const { getRealtimeForInjection } = await import('./retriever.js');
        const preview = getRealtimeForInjection(await getRealtimeMemories(chatId), getSettings());
        console.log(`[BB-Memory] 实时注入 ${preview.injectedCount}/${preview.totalCount} 条，`
            + `~${preview.tokenEstimate} tokens${preview.truncated ? '（已截断）' : ''}`);
        for (const line of preview.lines) console.log('  ' + line.text);
        return preview;
    },
    /** 只跑结算的三触发器判定（写库标记，不调 API） */
    check: async (floor) => {
        const chatId = getChatId();
        if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return null; }
        const chatLength = SillyTavern.getContext().chat?.length ?? 0;
        const { checkSettlement } = await import('./realtime-memory.js');
        const result = await checkSettlement(chatId, Number.isFinite(Number(floor)) ? Number(floor) : chatLength - 1);
        console.log(`[BB-Memory] 结算检查：活跃 ${result.activeCount}，标记 ${result.marked}，`
            + `待结算 ${result.pendingCount}，修剪留档 ${result.pruned}`);
        if (Object.keys(result.byReason).length) console.table(result.byReason);
        refreshRealtimeStatus();
        return result;
    },
    /** 完整跑一次结算（会调 API 并写库） */
    settle: async (options = {}) => {
        const chatId = getChatId();
        if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return null; }
        const chatLength = SillyTavern.getContext().chat?.length ?? 0;
        const { settleRealtimeMemories } = await import('./realtime-memory.js');
        const report = await settleRealtimeMemories(chatId, {
            manual: options.manual !== false,
            currentFloor: chatLength - 1,
            onProgress: ({ message }) => { if (message) console.log('[BB-Memory]', message); },
            ...options,
        });
        console.log(`[BB-Memory] 结算结果：${report.summary}`);
        if (report.applyResult?.promoted.length) {
            console.table(report.applyResult.promoted.map(p => ({
                原细节: p.entry.text,
                晋升到: p.ref.pillar,
                方式: p.ref.action,
                理由: p.reason,
            })));
        }
        if (report.rejected.length) console.warn('[BB-Memory] 被拦截的决定:', report.rejected);
        refreshRealtimeStatus();
        return report;
    },
    /** 撤销上次结算 */
    undo: async () => {
        const chatId = getChatId();
        if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return null; }
        const { undoLastSettlement } = await import('./realtime-memory.js');
        const result = await undoLastSettlement(chatId);
        console.log(result.ok ? `[BB-Memory] 撤销成功：${result.summary}` : `[BB-Memory] 撤销失败：${result.error}`);
        refreshRealtimeStatus();
        return result;
    },
    /** 列出结算撤销快照 */
    snapshots: async () => {
        const chatId = getChatId();
        if (!chatId) return [];
        const { listSettleSnapshots } = await import('./realtime-memory.js');
        const list = await listSettleSnapshots(chatId);
        console.table(list.map(s => ({
            快照: s.id,
            时间: new Date(s.timestamp).toLocaleString(),
            涉及条目: s.entryCount,
            晋升条目: s.promotedCount,
            摘要: s.summary,
        })));
        return list;
    },
};

globalThis.bbMemoryDebug = {
    getMemoryStats,
    getNpcProfiles,
    getItems,
    getMilestones,
    getTimeline,
    getTimelineEntries: getMilestones,
    getMemories,
    getRealtimeMemories,
    realtime: realtimeDebug,
    lastRetrievalResult: () => lastRetrievalResult,
    curator: {
        /** 聚类三组固定用例自检，不读库不发请求 */
        selfTest: async () => {
            const { __selfTestCurationGroups } = await import('./memory-curator.js');
            return printCuratorSelfTest('聚类', __selfTestCurationGroups());
        },
        /** 操作解析与拦截自检，不读库不发请求 */
        selfTestOps: async () => {
            const { __selfTestCurationOps } = await import('./memory-curator.js');
            return printCuratorSelfTest('操作解析', __selfTestCurationOps());
        },
        /** 授权矩阵与合并补丁自检，不读库不发请求 */
        selfTestAuth: async () => {
            const { __selfTestCurationAuth } = await import('./memory-curator.js');
            return printCuratorSelfTest('授权矩阵', __selfTestCurationAuth());
        },
        /** 触发条件与种子归一化自检，不读库不发请求 */
        selfTestTrigger: async () => {
            const { __selfTestCurationTrigger } = await import('./memory-curator.js');
            return printCuratorSelfTest('触发条件', __selfTestCurationTrigger());
        },
        /** 全部自检 */
        selfTestAll: async () => {
            const { __selfTestCurator } = await import('./memory-curator.js');
            return printCuratorSelfTest('全部', __selfTestCurator());
        },
        /** 撤销上次整理 */
        undo: async () => {
            const chatId = getChatId();
            if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return null; }
            const { undoLastCuration } = await import('./memory-curator.js');
            const result = await undoLastCuration(chatId);
            console.log(result.ok ? `[BB-Memory] 撤销成功：${result.summary}` : `[BB-Memory] 撤销失败：${result.error}`);
            return result;
        },
        /** 查看/重置整理计数器 */
        counters: async (reset = false) => {
            const chatId = getChatId();
            if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return null; }
            const { getCurationState, clearCurationCounters, shouldTriggerCuration } = await import('./memory-curator.js');
            if (reset) {
                clearCurationCounters(chatId);
                console.log('[BB-Memory] 整理计数器已清零');
            }
            const s = getSettings();
            const state = getCurationState(chatId, s);
            console.table(Object.entries(CURATE_THRESHOLD_LABELS).map(([pillar, [label, key]]) => ({
                柱: label,
                计数: state.counters[pillar] || 0,
                阈值: s[key],
                种子数: state.seeds[pillar]?.length || 0,
            })));
            console.log(`[BB-Memory] 触发模式=${s.aiCurateTriggerMode} 是否达标=${shouldTriggerCuration(state.counters, s)}`);
            refreshCurateStatus();
            return state;
        },
        /** 列出撤销快照栈 */
        snapshots: async () => {
            const chatId = getChatId();
            if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return []; }
            const { listCurationSnapshots } = await import('./memory-curator.js');
            const list = await listCurationSnapshots(chatId);
            console.table(list.map(s => ({
                快照: s.id,
                时间: new Date(s.timestamp).toLocaleString(),
                来源: s.source,
                操作数: s.opCount,
                已应用: s.applied,
                摘要: s.summary,
                柱: (s.pillars || []).join('/'),
            })));
            return list;
        },
        /** 完整跑一次整理（会写库，走授权矩阵） */
        run: async (options = {}) => {
            const chatId = getChatId();
            if (!chatId) { console.warn('[BB-Memory] 未打开聊天'); return null; }
            const { runCurationFlow } = await import('./memory-curator.js');
            const report = await runCurationFlow(chatId, {
                source: 'manual',
                onProgress: ({ message }) => { if (message) console.log('[BB-Memory]', message); },
                ...options,
            });
            console.log(`[BB-Memory] 整理结果：${report.summary}`);
            if (report.applyResult?.snapshotId) {
                console.log(`[BB-Memory] 撤销快照 ${report.applyResult.snapshotId}，用 bbMemoryDebug.curator.undo() 回滚`);
            }
            return report;
        },
        /** 对当前聊天真实数据跑一次聚类并打印组内相似度矩阵，不写库 */
        buildGroups: debugCuratorBuildGroups,
        /** 真实数据 + 真实 API 跑一次整理判断，只打印操作清单，**不写库** */
        dryRun: debugCuratorDryRun,
        /** 对任意条目数组打印两两相似度矩阵 */
        matrix: async (entries, pillar = 'mem') => {
            const { buildSimilarityMatrix } = await import('./memory-curator.js');
            const matrix = buildSimilarityMatrix(entries, pillar);
            console.table(matrix);
            return matrix;
        },
    },
};

// ═══ 启动 ═══
let _bbInitCalled = false;
async function initOnce() {
    if (_bbInitCalled) return;
    _bbInitCalled = true;
    await init();
}

// v8.4.1: 兜底定时器，确保即使 APP_READY 未触发也能初始化
const FALLBACK_DELAY_MS = 10000;

try {
    const ctx = SillyTavern.getContext();
    const evType = ctx.eventTypes?.APP_READY || ctx.event_types?.APP_READY;
    if (evType && ctx.eventSource) {
        if (typeof ctx.eventSource.once === 'function') {
            ctx.eventSource.once(evType, initOnce);
        } else if (typeof ctx.eventSource.on === 'function') {
            const onReady = async (...args) => {
                try {
                    if (typeof ctx.eventSource.removeListener === 'function') {
                        ctx.eventSource.removeListener(evType, onReady);
                    } else if (typeof ctx.eventSource.off === 'function') {
                        ctx.eventSource.off(evType, onReady);
                    }
                } catch { /* ignore missing event cleanup */ }
                await initOnce(...args);
            };
            ctx.eventSource.on(evType, onReady);
        } else {
            throw new Error('SillyTavern eventSource does not support once/on');
        }
        // 兜底：如果 APP_READY 10 秒后仍未触发，直接初始化
        setTimeout(() => {
            if (!_bbInitCalled) {
                console.warn('[BB-Memory] APP_READY 超时(' + FALLBACK_DELAY_MS/1000 + 's)，使用兜底初始化');
                initOnce();
            }
        }, FALLBACK_DELAY_MS);
    } else {
        // 降级：DOM ready 后初始化
        if (document.readyState === 'complete') initOnce();
        else window.addEventListener('load', initOnce);
    }
} catch (e) {
    console.error('[BB-Memory] 启动失败:', e);
    if (document.readyState === 'complete') initOnce();
    else window.addEventListener('load', initOnce);
}
