/**
 * BISECT TEST — 分步导入排查
 */
console.log('[BB-Memory] ======== 分步导入测试 ========');

// Step 1: 纯数据模块（无其他依赖）
try {
    const m1 = await import('./memory-types.js');
    console.log('[BB-Memory] Step 1 OK: memory-types.js —', Object.keys(m1).join(', '));
} catch (e) {
    console.error('[BB-Memory] Step 1 FAIL: memory-types.js —', e.message);
}

try {
    const m2 = await import('./entity-tiers.js');
    console.log('[BB-Memory] Step 2 OK: entity-tiers.js —', Object.keys(m2).join(', '));
} catch (e) {
    console.error('[BB-Memory] Step 2 FAIL: entity-tiers.js —', e.message);
}

// Step 3: memory-store.js（依赖 entity-tiers）
try {
    const m3 = await import('./memory-store.js');
    console.log('[BB-Memory] Step 3 OK: memory-store.js —', Object.keys(m3).join(', '));
} catch (e) {
    console.error('[BB-Memory] Step 3 FAIL: memory-store.js —', e.message);
}

// Step 4: retriever.js（依赖 memory-types, entity-tiers）
try {
    const m4 = await import('./retriever.js');
    console.log('[BB-Memory] Step 4 OK: retriever.js —', Object.keys(m4).join(', '));
} catch (e) {
    console.error('[BB-Memory] Step 4 FAIL: retriever.js —', e.message);
}

// Step 5: message-state.js（依赖 memory-store）
try {
    const m5 = await import('./message-state.js');
    console.log('[BB-Memory] Step 5 OK: message-state.js —', Object.keys(m5).join(', '));
} catch (e) {
    console.error('[BB-Memory] Step 5 FAIL: message-state.js —', e.message);
}

// Step 6: auto-generator.js（依赖 memory-store, message-state）
try {
    const m6 = await import('./auto-generator.js');
    console.log('[BB-Memory] Step 6 OK: auto-generator.js —', Object.keys(m6).join(', '));
} catch (e) {
    console.error('[BB-Memory] Step 6 FAIL: auto-generator.js —', e.message);
}

// Step 7: memory-maintainer.js（依赖 memory-store, auto-generator）
try {
    const m7 = await import('./memory-maintainer.js');
    console.log('[BB-Memory] Step 7 OK: memory-maintainer.js —', Object.keys(m7).join(', '));
} catch (e) {
    console.error('[BB-Memory] Step 7 FAIL: memory-maintainer.js —', e.message);
}

// Step 8: memory-assistant.js（依赖 memory-types, entity-tiers, memory-store, retriever）
try {
    const m8 = await import('./memory-assistant.js');
    console.log('[BB-Memory] Step 8 OK: memory-assistant.js —', Object.keys(m8).join(', '));
} catch (e) {
    console.error('[BB-Memory] Step 8 FAIL: memory-assistant.js —', e.message);
}

console.log('[BB-Memory] ======== 分步导入测试完成 ========');

// 占位拦截器
globalThis.bbMemoryInterceptor = function (chat) { return chat; };
