/**
 * BISECT TEST 2 — 静态 imports + 最小代码
 */
import {
    MODULE_NAME, DEFAULT_SETTINGS, getSettings, updateSettings,
    getNpcProfiles, getItems, getTimeline, getMemories,
    getMemoryStats,
} from './memory-store.js';

import { getNpcForInjection, buildMemoryInjectionPrompt } from './retriever.js';
import { MEMORY_TYPES } from './memory-types.js';
import { openAssistant } from './memory-assistant.js';

console.log('[BB-Memory] ✅ 静态 imports 全部成功！');
console.log('[BB-Memory] MODULE_NAME:', MODULE_NAME);

// 最小拦截器
globalThis.bbMemoryInterceptor = function (chat) { return chat; };

// 简单初始化
const ctx = SillyTavern.getContext();
const ev = ctx.event_types ?? ctx.eventTypes;
if (ctx.eventSource && ev?.APP_READY) {
    ctx.eventSource.on(ev.APP_READY, () => console.log('[BB-Memory] APP_READY 触发'));
} else {
    console.log('[BB-Memory] 直接初始化, readyState:', document.readyState);
}
console.log('[BB-Memory] ✅ 静态导入测试完成');
