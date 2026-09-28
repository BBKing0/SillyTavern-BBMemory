/** v9.4.8 注入与留档共用的实时细节有效期规则（无存储依赖）。 */
function clampInt(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

export function isSceneChanged(prevKey, nextKey) {
    const a = String(prevKey || '').trim();
    const b = String(nextKey || '').trim();
    if (!a || !b) return false;
    return a !== b;
}

export function deriveSceneState(entries) {
    const pool = (Array.isArray(entries) ? entries : []).filter(e =>
        e && e.kind !== 'schedule' && e.settleState !== 'settled');
    if (!pool.length) return { sceneKey: '', location: '', storyTime: '', floors: [] };
    const newest = pool.reduce((best, entry) => {
        const a = Number(entry.lastSeenFloor ?? -1);
        const b = Number(best.lastSeenFloor ?? -1);
        if (a > b) return entry;
        if (a === b && Number(entry.createdAt || 0) > Number(best.createdAt || 0)) return entry;
        return best;
    });
    const sceneKey = String(newest.sceneKey || '');
    const sameScene = pool.filter(e => String(e.sceneKey || '') === sceneKey);
    const floors = [...new Set(sameScene
        .map(e => Number(e.createdFloor))
        .filter(n => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b);
    return {
        sceneKey,
        location: newest.location || '',
        storyTime: newest.storyTime || '',
        floors,
    };
}

export function planSettlement(entries, currentFloor, settings = {}) {
    const all = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const pool = all.filter(e => e.kind !== 'schedule' && e.settleState === 'active');
    if (!pool.length) return { marks: [], byReason: {}, activeCount: 0 };

    const floor = Number(currentFloor);
    const ttl = clampInt(settings.realtimeTtlFloors, 0, 500, 12);
    const maxEntries = clampInt(settings.realtimeMaxEntries, 0, 500, 40);
    const sceneChangeEnabled = settings.realtimeSceneChangeSettle !== false;

    // 当前场景 = 最新未结算条目所在场景
    const currentScene = deriveSceneState(all).sceneKey;

    const marks = new Map();
    const mark = (entry, reason) => {
        if (!marks.has(entry.id)) marks.set(entry.id, { id: entry.id, reason });
    };

    if (sceneChangeEnabled && currentScene) {
        for (const entry of pool) {
            if (isSceneChanged(entry.sceneKey, currentScene)) mark(entry, 'scene_change');
        }
    }
    if (ttl > 0 && Number.isFinite(floor)) {
        for (const entry of pool) {
            const seen = Number(entry.lastSeenFloor ?? entry.createdFloor ?? -1);
            if (Number.isFinite(seen) && seen >= 0 && floor - seen >= ttl) mark(entry, 'ttl');
        }
    }
    if (maxEntries > 0) {
        const stillActive = pool.filter(entry => !marks.has(entry.id));
        const overflow = stillActive.length - maxEntries;
        if (overflow > 0) {
            const oldestFirst = stillActive.slice().sort((a, b) =>
                (Number(a.lastSeenFloor ?? -1) - Number(b.lastSeenFloor ?? -1))
                || (Number(a.createdAt || 0) - Number(b.createdAt || 0)));
            for (const entry of oldestFirst.slice(0, overflow)) mark(entry, 'capacity');
        }
    }

    const byReason = {};
    for (const item of marks.values()) byReason[item.reason] = (byReason[item.reason] || 0) + 1;
    return { marks: [...marks.values()], byReason, activeCount: pool.length };
}
