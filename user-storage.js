/** v9.4.9 账号隔离。旧版无归属键永不自动读取、认领或删除。
 * ST 身份接口：src/endpoints/users-private.js GET /api/users/me。
 * 身份与本页绑定；检测到切号后锁住旧页面，必须刷新后才能继续。
 */
let identity = null;
let pending = null;
let locked = false;
let settingsOwner = null;
let channel = null;
const accountError = () => new Error('BB-Memory 无法确认当前登录账号或账号已切换；已停止读写，请刷新页面后重试');

function checkOwner() {
    if (locked || (settingsOwner && settingsOwner !== globalThis.SillyTavern?.getContext?.()?.extensionSettings)) {
        locked = true;
        throw accountError();
    }
}

export async function initializeUserStorage({ verify = false } = {}) {
    checkOwner();
    if (pending) return pending;
    if (identity && !verify) return identity;
    pending = (async () => {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const owner = ctx?.extensionSettings;
        if (!owner) throw accountError();
        const response = await fetch('/api/users/me', {
            credentials: 'same-origin', cache: 'no-store',
            headers: ctx.getRequestHeaders?.() || {},
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw accountError();
        const user = await response.json();
        if (typeof user?.handle !== 'string' || !user.handle.trim()) throw accountError();
        const scope = `bb_user_v1_${encodeURIComponent(JSON.stringify([user.handle, user.created ?? '']))}::`;
        if ((identity && identity.scope !== scope) || owner !== globalThis.SillyTavern?.getContext?.()?.extensionSettings) {
            locked = true;
            throw accountError();
        }
        settingsOwner = owner;
        identity = Object.freeze({ handle: user.handle, scope });
        // 新账号页面一旦就绪，同源的旧账号标签页立即停止后续任务。
        if (!channel && globalThis.document && typeof BroadcastChannel === 'function') {
            channel = new BroadcastChannel('bb-memory-account-session');
            channel.onmessage = event => {
                if (typeof event.data?.scope === 'string' && event.data.scope !== identity.scope) {
                    locked = true;
                    globalThis.toastr?.error?.(accountError().message, 'BB-Memory 账号保护', { timeOut:0 });
                }
            };
            channel.postMessage({ scope });
        }
        return identity;
    })();
    try { return await pending; }
    catch (error) { if (identity) locked = true; throw error; }
    finally { pending = null; }
}

export function userStorageKey(key) {
    checkOwner();
    if (!identity) throw accountError();
    return identity.scope + String(key);
}

/** 只暴露本账号的逻辑键，存档扫描/救援/删除也无法跨命名空间。 */
export function getUserLocalForage() {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const raw = ctx?.libs?.localforage || globalThis.SillyTavern?.libs?.localforage || globalThis.localforage;
    if (!raw) throw new Error('BB-Memory 本地存储不可用');
    const ready = initializeUserStorage();
    // 初始化失败由每次实际操作向调用者报告，避免未使用适配器的拒绝泄漏。
    ready.catch(() => {});
    const keyOf = async key => { await ready; return userStorageKey(key); };
    return {
        async getItem(key) { const value = await raw.getItem(await keyOf(key)); checkOwner(); return value; },
        async setItem(key, value) { return raw.setItem(await keyOf(key), value); },
        async removeItem(key) { return raw.removeItem(await keyOf(key)); },
        async keys() {
            const { scope } = await ready; checkOwner();
            const keys = await raw.keys(); checkOwner();
            return keys.filter(key => key.startsWith(scope)).map(key => key.slice(scope.length));
        },
        async iterate(callback) {
            const { scope } = await ready; checkOwner();
            let index = 0;
            return raw.iterate((value, key) => {
                checkOwner();
                if (key.startsWith(scope)) return callback(value, key.slice(scope.length), ++index);
            });
        },
    };
}

let watching = false;
export function watchUserSession() {
    if (watching || !globalThis.document) return;
    watching = true;
    const verify = () => {
        if (document.visibilityState === 'hidden') return;
        initializeUserStorage({ verify: true }).catch(error => {
            globalThis.toastr?.error?.(error.message, 'BB-Memory 账号保护', { timeOut: 0 });
        });
    };
    window.addEventListener('focus', verify);
    document.addEventListener('visibilitychange', verify);
}
