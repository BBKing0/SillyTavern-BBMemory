/**
 * MINIMAL TEST — 排查 BB-Memory 模块是否被 ST 加载
 */
console.log('[BB-Memory-TEST] ======== 模块文件已执行 ========');

// 检测是否作为 ES Module 加载
try {
    console.log('[BB-Memory-TEST] import.meta.url:', import.meta.url);
} catch (e) {
    console.log('[BB-Memory-TEST] import.meta 不可用（可能非ESM加载）:', e.message);
}

// 检测 ST 环境
try {
    const ctx = SillyTavern.getContext();
    console.log('[BB-Memory-TEST] SillyTavern.getContext() 成功, chatId:', ctx?.chatId);
} catch (e) {
    console.error('[BB-Memory-TEST] SillyTavern.getContext() 失败:', e.message);
}

// 检测 DOM
console.log('[BB-Memory-TEST] document.readyState:', document.readyState);
console.log('[BB-Memory-TEST] #extensions_settings2 存在?', !!document.getElementById('extensions_settings2'));

// 占位拦截器
globalThis.bbMemoryInterceptor = function (chat) {
    return chat;
};

console.log('[BB-Memory-TEST] ======== 测试完成 ========');
