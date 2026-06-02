/**
 * graph-view-core.js - small shared viewport helper for map/clue spatial views.
 *
 * It keeps graph zoom as a camera transform only. DOM nodes should be positioned
 * from worldToScreen() and keep their own fixed CSS size.
 */

export function createGraphViewport(container, options = {}) {
    return {
        container,
        scale: options.scale || 1,
        panX: options.panX || 0,
        panY: options.panY || 0,
        minScale: options.minScale || 0.35,
        maxScale: options.maxScale || 3,
        minHeight: options.minHeight || 400,
        getSize() {
            const rect = container.getBoundingClientRect();
            return {
                w: Math.max(1, rect.width || container.clientWidth || 1),
                h: Math.max(this.minHeight, rect.height || container.clientHeight || this.minHeight),
            };
        },
    };
}

export function worldToScreen(node, viewport) {
    const { w, h } = viewport.getSize();
    const x = Number.isFinite(node?.x) ? node.x : 0.5;
    const y = Number.isFinite(node?.y) ? node.y : 0.5;
    return {
        x: x * w * viewport.scale + viewport.panX,
        y: y * h * viewport.scale + viewport.panY,
    };
}

export function screenToWorld(point, viewport) {
    const { w, h } = viewport.getSize();
    return {
        x: (point.x - viewport.panX) / (w * viewport.scale),
        y: (point.y - viewport.panY) / (h * viewport.scale),
    };
}

export function fitToGraph(nodes, viewport, options = {}) {
    const visible = (nodes || []).filter(Boolean);
    const { w, h } = viewport.getSize();
    if (!visible.length) {
        viewport.scale = 1;
        viewport.panX = w * 0.5 - w * 0.5;
        viewport.panY = h * 0.5 - h * 0.5;
        return viewport;
    }

    const pad = options.padding ?? 80;
    const minX = Math.min(...visible.map(n => Number.isFinite(n.x) ? n.x : 0.5));
    const maxX = Math.max(...visible.map(n => Number.isFinite(n.x) ? n.x : 0.5));
    const minY = Math.min(...visible.map(n => Number.isFinite(n.y) ? n.y : 0.5));
    const maxY = Math.max(...visible.map(n => Number.isFinite(n.y) ? n.y : 0.5));
    const rangeX = Math.max(0.08, maxX - minX);
    const rangeY = Math.max(0.08, maxY - minY);
    const usableW = Math.max(1, w - pad * 2);
    const usableH = Math.max(1, h - pad * 2);
    const scaleX = usableW / (rangeX * w);
    const scaleY = usableH / (rangeY * h);
    const nextScale = Math.min(options.maxScale || viewport.maxScale, Math.max(options.minScale || viewport.minScale, Math.min(scaleX, scaleY)));

    viewport.scale = nextScale;
    viewport.panX = (w - (minX + maxX) * w * nextScale) / 2;
    viewport.panY = (h - (minY + maxY) * h * nextScale) / 2;
    return viewport;
}

export function zoomAt(viewport, screenPoint, nextScale) {
    const clamped = Math.max(viewport.minScale, Math.min(viewport.maxScale, nextScale));
    const oldScale = viewport.scale || 1;
    if (Math.abs(clamped - oldScale) < 0.001) return viewport;

    viewport.panX = screenPoint.x - (screenPoint.x - viewport.panX) * clamped / oldScale;
    viewport.panY = screenPoint.y - (screenPoint.y - viewport.panY) * clamped / oldScale;
    viewport.scale = clamped;
    return viewport;
}

export function bindGraphPointerControls(container, viewport, handlers = {}) {
    let panning = false;
    let lastX = 0;
    let lastY = 0;
    let pinch = null;

    const rectPoint = (clientX, clientY) => {
        const rect = container.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const shouldPan = (event) => !handlers.shouldStartPan || handlers.shouldStartPan(event);
    const notify = () => {
        if (typeof handlers.onChange === 'function') handlers.onChange(viewport);
    };

    function onMouseDown(event) {
        if (event.button !== 0 || !shouldPan(event)) return;
        panning = true;
        lastX = event.clientX;
        lastY = event.clientY;
        event.preventDefault();
    }

    function onMouseMove(event) {
        if (!panning) return;
        viewport.panX += event.clientX - lastX;
        viewport.panY += event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        notify();
    }

    function onMouseUp() {
        panning = false;
    }

    function onWheel(event) {
        event.preventDefault();
        const point = rectPoint(event.clientX, event.clientY);
        const factor = event.deltaY > 0 ? 0.9 : 1.1;
        zoomAt(viewport, point, viewport.scale * factor);
        notify();
    }

    function touchCenter(touches) {
        return {
            x: (touches[0].clientX + touches[1].clientX) / 2,
            y: (touches[0].clientY + touches[1].clientY) / 2,
        };
    }

    function touchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function onTouchStart(event) {
        if (event.touches.length === 1 && shouldPan(event)) {
            panning = true;
            lastX = event.touches[0].clientX;
            lastY = event.touches[0].clientY;
        } else if (event.touches.length === 2) {
            const center = touchCenter(event.touches);
            pinch = {
                distance: touchDistance(event.touches),
                scale: viewport.scale,
                center: rectPoint(center.x, center.y),
            };
            panning = false;
        }
    }

    function onTouchMove(event) {
        if (event.touches.length === 1 && panning) {
            event.preventDefault();
            const touch = event.touches[0];
            viewport.panX += touch.clientX - lastX;
            viewport.panY += touch.clientY - lastY;
            lastX = touch.clientX;
            lastY = touch.clientY;
            notify();
        } else if (event.touches.length === 2 && pinch) {
            event.preventDefault();
            const center = touchCenter(event.touches);
            const point = rectPoint(center.x, center.y);
            const ratio = touchDistance(event.touches) / Math.max(1, pinch.distance);
            zoomAt(viewport, point, pinch.scale * ratio);
            notify();
        }
    }

    function onTouchEnd(event) {
        if (event.touches.length === 0) {
            panning = false;
            pinch = null;
        }
    }

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('touchcancel', onTouchEnd);

    return () => {
        container.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        container.removeEventListener('wheel', onWheel);
        container.removeEventListener('touchstart', onTouchStart);
        container.removeEventListener('touchmove', onTouchMove);
        container.removeEventListener('touchend', onTouchEnd);
        container.removeEventListener('touchcancel', onTouchEnd);
    };
}
