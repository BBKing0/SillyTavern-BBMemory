/**
 * BISECT TEST 3 — 全量静态 imports + 最小代码
 */
console.log('[BB-Memory] 开始加载...');

import {
    MODULE_NAME, DEFAULT_SETTINGS, getSettings, updateSettings,
    getNpcProfiles, addNpcProfile, updateNpcProfile, removeNpcProfile, upsertNpcProfile,
    getItems, addItem, updateItem, removeItem, upsertItem,
    getTimeline, addTimelineEntry, updateTimelineEntry, removeTimelineEntry, upsertTimelineEntry,
    getMemories, addMemory, updateMemory, removeMemory,
    clearAllData, getMemoryStats,
    exportMemoriesToChatMetadata, importMemoriesFromChatMetadata,
    migrateV4ToV5, recordHits, checkDemotions,
    exportMemories, importMemories, updateFactContent, addHiddenNote, removeHiddenNote,
    scheduleAutoBackup, extractKeywords,
} from './memory-store.js';

import {
    getRelevantMemories, getResidentMemories, buildMemoryInjectionPrompt,
    mergeExpandedRelevantResults, simpleSearch, searchMemories,
    getNpcForInjection, getItemsForInjection, getTimelineForInjection,
} from './retriever.js';

import { MEMORY_TYPES, TRUTH_STATUS, HIDDEN_NOTE_TYPES } from './memory-types.js';
import { NPC_TIERS, ITEM_TIERS, expandMemoriesForEntityKeyword } from './entity-tiers.js';

import {
    initAutoGenerator, stopAutoGenerator, extractFromContext, saveExtractedMemories,
    setAutoExtractProgressCallback, getPendingAutoCandidates, clearPendingAutoCandidates,
    callEmbeddingApi, embedExistingMemories,
} from './auto-generator.js';

import {
    syncMessageVisibility, refreshExtractionMarkers,
    markExchangeExtracted, hideExchange,
} from './message-state.js';

import {
    MEMORY_STATUS, checkMaintenanceNeeded, dismissMaintenanceRemind,
    performMaintenance, buildMaintenanceHTML,
    fuzzyMemory, archiveMemory, restoreMemory, autoMaintain,
    generateTimelineSummary,
} from './memory-maintainer.js';

import { openAssistant } from './memory-assistant.js';

console.log('[BB-Memory] ✅ 全量静态 imports 成功！');
console.log('[BB-Memory] MODULE_NAME:', MODULE_NAME);
console.log('[BB-Memory] 导入模块数: memory-store, retriever, memory-types, entity-tiers, auto-generator, message-state, memory-maintainer, memory-assistant');

// 占位拦截器
globalThis.bbMemoryInterceptor = function (chat) { return chat; };

console.log('[BB-Memory] ✅ 全量导入测试完成');
