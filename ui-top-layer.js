/**
 * ui-top-layer.js — BB-Memory v9.4.3 原生顶层弹窗适配
 *
 * SillyTavern 的移动端抽屉可能通过 popover/dialog 进入浏览器 top layer。
 * 普通 fixed 元素即使使用最大 z-index 也无法覆盖它，因此 BB-Memory 的
 * 关键交互弹窗优先使用 Popover API；旧浏览器则保留 fixed + z-index 回退。
 */

export function mountInTopLayer(element) {
    if (!element) return element;
    if (!element.isConnected) document.body.appendChild(element);

    if (typeof element.showPopover !== 'function') return element;

    element.setAttribute('popover', 'manual');
    element.classList.add('bb-native-top-layer');
    element.setAttribute('role', element.getAttribute('role') || 'dialog');
    element.setAttribute('aria-modal', 'true');
    try {
        element.showPopover();
        element.dataset.bbNativeTopLayer = 'true';
    } catch (error) {
        // 某些旧 WebView 暴露了不完整的 API；恢复普通 fixed 弹窗。
        element.removeAttribute('popover');
        element.classList.remove('bb-native-top-layer');
        delete element.dataset.bbNativeTopLayer;
        if (globalThis.bbMemoryDebug?.settings?.debugLogging) {
            console.warn('[BB-Memory] 原生顶层弹窗不可用，已使用 z-index 回退：', error);
        }
    }
    return element;
}

export function removeTopLayerElement(element) {
    if (!element) return;
    if (typeof element.hidePopover === 'function') {
        try { element.hidePopover(); } catch { /* 已关闭或未进入 top layer */ }
    }
    element.remove();
}
