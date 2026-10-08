/** Explicit AI changes use the existing review UI, snapshots and reference repair. */
import { getSettings, getMemories, getNpcProfiles, getItems, getMilestones, getTimeline } from './memory-store.js';
import { isDailyMemory } from './memory-tags.js';
import { extractionEntryFingerprint, normalizeExtractionPillar } from './extraction-context.js';
import { getUserLocalForage } from './user-storage.js';

const LOADERS = { mem: getMemories, npc: getNpcProfiles, item: getItems, milestone: getMilestones, timeline: getTimeline };
const IDENTITY_FIELDS = ['role', 'personality', 'appearance', 'relationships'];
let writeChain = Promise.resolve();
let reviewChain = Promise.resolve();
let draftChain = Promise.resolve();
const reviewObservers = new Map();

const draftKey = chatId => `bb_extraction_update_drafts_chat_${chatId}`;
export async function listPendingExtractionUpdates(chatId) {
    const batches = await getUserLocalForage().getItem(draftKey(chatId));
    return Array.isArray(batches) ? batches : [];
}

function updateDrafts(chatId, transform) {
    const run = draftChain.then(async () => {
        const batches = await listPendingExtractionUpdates(chatId);
        const next = transform(batches);
        await getUserLocalForage().setItem(draftKey(chatId), next);
        return next;
    });
    draftChain = run.catch(() => {});
    return run;
}

export function serializeExtractionWrite(task) {
    const run = writeChain.then(task);
    writeChain = run.catch(() => {});
    return run;
}

function notify(message, type = 'info') {
    globalThis.bbMemoryShowToast?.(message, type);
    globalThis.bbMemoryRecordActivity?.(type, '提取条目变更', message);
}

export async function parseExtractionUpdates(rawOps, context) {
    const curator = await import('./memory-curator.js');
    const rejected = [];
    const eligible = [];
    for (const raw of (Array.isArray(rawOps) ? rawOps : [])) {
        const op = String(raw?.op || raw?.action || '').toLowerCase();
        if (!['update', 'rewrite', 'merge', 'delete'].includes(op)) {
            rejected.push({ reason: `提取不支持操作 ${op || '(空)'}` }); continue;
        }
        if (!String(raw.reason || '').trim()) { rejected.push({ reason: '条目变更缺少剧情证据 reason' }); continue; }
        if (normalizeExtractionPillar(raw.pillar) === 'npc' && ['update', 'rewrite'].includes(op)
            && !['identity', 'attitude', 'relationship', 'persistent_trait', 'persistent_status'].includes(raw.changeKind)) {
            rejected.push({ reason: 'NPC 更新缺少明确的身份、态度、关系或稳定特征变化类型' }); continue;
        }
        eligible.push({ ...raw, op: op === 'update' ? 'rewrite' : op, pillar: normalizeExtractionPillar(raw.pillar) });
    }
    const parsed = curator.parseCurationOps(JSON.stringify({ ops: eligible }), { entries: context?.entries || {}, allowEmptyOps: true });
    const ops = [];
    for (const op of parsed.ops) {
        const raw = eligible.find(item => item.op === op.op && item.pillar === op.pillar
            && String(Array.isArray(item.ids) ? item.ids[0] : item.id || '') === String(op.ids[0]));
        op.changeKind = raw?.changeKind || '';
        const targets = (context?.entries?.[op.pillar] || []).filter(entry => op.ids.includes(String(entry.id)));
        const reason = validateProtectedTargets(op, targets);
        if (reason) { rejected.push({ op: op.op, pillar: op.pillar, ids: op.ids, reason }); continue; }
        if (op.pillar === 'milestone' && op.result?.timelineId
            && !(context?.entries?.timeline || []).some(entry => String(entry.id) === String(op.result.timelineId))) {
            rejected.push({ reason: '里程碑所属时间线不在本次候选中，已拦截未知标签' }); continue;
        }
        op.extractionFingerprints = Object.fromEntries(op.ids.map(id => [id, context?.fingerprints?.[op.pillar]?.[id] || '']));
        op.issueCategory = op.issueCategory === '其他' ? '剧情状态更新' : op.issueCategory;
        ops.push(op);
    }
    return { ops, rejected: [...rejected, ...parsed.rejected] };
}

function validateProtectedTargets(op, targets) {
    if (targets.some(entry => entry.memoryTier === 'eternal')) return '永恒条目不会由提取流程改动';
    if (targets.some(entry => entry.keepPermanent === true && (op.op === 'delete'
        || op.op === 'merge' && String(entry.id) !== String(op.keepId)))) return '永久保留物品禁止删除或作为合并被吸收方';
    if (op.pillar === 'mem' && targets.some(isDailyMemory)) return '日常记忆保留原记录，不执行更新、合并或删除';
    if (op.pillar === 'npc' && op.op === 'rewrite') {
        const base = targets[0];
        const persistent = IDENTITY_FIELDS.some(field => Object.prototype.hasOwnProperty.call(op.result || {}, field)
            && JSON.stringify(op.result[field]) !== JSON.stringify(base?.[field]))
            || op.changeKind === 'persistent_status' && op.result?.status !== base?.status
                && Boolean(String(op.result?.status || '').trim());
        if (!persistent) return 'NPC 只有动作、位置或临时状态变化，不更新人物档案';
    }
    return '';
}

async function validateCurrentOps(chatId, ops) {
    if (String(globalThis.SillyTavern?.getContext?.()?.chatId || '') !== String(chatId)) throw new Error('聊天已切换，请回到原聊天应用变更');
    const pools = {};
    for (const pillar of new Set(ops.map(op => op.pillar))) pools[pillar] = await LOADERS[pillar](chatId);
    for (const op of ops) {
        const targets = op.ids.map(id => pools[op.pillar].find(entry => String(entry.id) === String(id)));
        if (targets.some(entry => !entry)) throw new Error('候选条目已经删除，须重新提取后确认');
        if (targets.some(entry => extractionEntryFingerprint(entry) !== op.extractionFingerprints?.[entry.id])) {
            throw new Error('候选条目已被编辑或另一轮提取修改，须重新提取后确认');
        }
        const reason = validateProtectedTargets(op, targets);
        if (reason) throw new Error(reason);
    }
}

export async function applyExtractionUpdates(chatId, ops, options = {}) {
    return serializeExtractionWrite(async () => {
        const curator = await import('./memory-curator.js');
        await validateCurrentOps(chatId, ops);
        return curator.applyCurationOps(chatId, ops, { ...options, forceAuth: 'auto', source: 'extraction',
            validateOp: op => validateCurrentOps(chatId, [op]),
        });
    });
}

export async function processExtractionUpdates(chatId, rawOps, context, options = {}) {
    const parsed = await parseExtractionUpdates(rawOps, context);
    if (parsed.rejected.length) notify(`已拦截 ${parsed.rejected.length} 项不安全或无效变更：${parsed.rejected.map(item => item.reason).join('；')}`, 'warning');
    if (!parsed.ops.length) return { ...parsed, applied: 0, pending: 0 };
    if (getSettings().extractionUpdateConfirm !== false) {
        const batch = { id: `extract_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            chatId: String(chatId), createdAt: Date.now(), ops: parsed.ops, context };
        await updateDrafts(chatId, batches => [...batches, batch]);
        notify(`${parsed.ops.length} 项更新、合并或删除等待确认`);
        void reviewPendingExtractionUpdates(chatId, options).catch(error => notify(`变更审核失败：${error.message}`, 'error'));
        // Extraction can finish and hide processed floors while the independent review remains open.
        return { ...parsed, applied: 0, pending: parsed.ops.length };
    }
    const cautions = parsed.ops.flatMap(op => op.forceConfirm ? op.notes || [] : []);
    if (cautions.length) notify(`变更提醒：${cautions.join('；')}`, 'warning');
    const applied = await applyExtractionUpdates(chatId, parsed.ops, options);
    notify(`条目变更完成：${applied.summary}${applied.failed.length ? `；${applied.failed.length} 项失败` : ''}`, applied.failed.length ? 'warning' : 'success');
    return { ...parsed, applied: applied.applied.length, pending: 0, applyResult: applied };
}

export function reviewPendingExtractionUpdates(chatId, options = {}) {
    const run = reviewChain.then(async () => {
        const curator = await import('./memory-curator.js');
        const batches = await listPendingExtractionUpdates(chatId);
        const reviews = [];
        for (const batch of batches) {
            if (String(globalThis.SillyTavern?.getContext?.()?.chatId || '') !== String(chatId)) break;
            if (globalThis.document?.getElementById('bb_curate_review_overlay')) {
                notify('已有审核窗口，提取变更已保存；关闭该窗口后可重新打开提取变更审核');
                scheduleReviewAfterOverlay(chatId, options);
                break;
            }
            const review = await curator.openCurationReviewPanel(chatId, batch.ops, {
                title: '提取条目变更确认', settings: getSettings(), apply: applyExtractionUpdates,
                validateOp: op => {
                    const targets = (batch.context.entries[op.pillar] || []).filter(entry => op.ids.includes(String(entry.id)));
                    const reason = validateProtectedTargets(op, targets);
                    if (reason) throw new Error(reason);
                    if (op.pillar === 'milestone' && op.result?.timelineId
                        && !(batch.context.entries.timeline || []).some(entry => entry.id === op.result.timelineId)) {
                        throw new Error('里程碑所属时间线不在本次候选中');
                    }
                },
            });
            reviews.push(review);
            options.onComplete?.(review);
            if (review.closed) {
                notify('已保留提取变更草稿，可稍后重新打开审核');
                break;
            }
            if (review.applyResult) {
                const applied = new Set((review.applyResult.applied || []).map(op => `${op.pillar}|${op.op}|${op.ids.join(',')}`));
                await updateDrafts(chatId, list => list.map(entry => entry.id !== batch.id ? entry : {
                    ...entry, ops: entry.ops.filter(op => !applied.has(`${op.pillar}|${op.op}|${op.ids.join(',')}`)),
                }).filter(entry => entry.ops.length));
            } else {
                // Explicit rejection discards the draft; closing the window preserves it above.
                await updateDrafts(chatId, list => list.filter(entry => entry.id !== batch.id));
            }
        }
        const pending = (await listPendingExtractionUpdates(chatId)).reduce((sum, batch) => sum + batch.ops.length, 0);
        const applied = reviews.reduce((sum, review) => sum + (review.applyResult?.applied?.length || 0), 0);
        const summary = pending ? `仍有 ${pending} 项提取变更待审核` : applied ? `已应用 ${applied} 项提取变更`
            : reviews.length ? '提取变更已拒绝' : '暂无待审核变更';
        return { reviews, pending, applied, summary };
    });
    reviewChain = run.catch(() => {});
    return run;
}

function scheduleReviewAfterOverlay(chatId, options) {
    if (reviewObservers.has(String(chatId)) || !globalThis.MutationObserver || !globalThis.document?.documentElement) return;
    const observer = new MutationObserver(() => {
        if (document.getElementById('bb_curate_review_overlay')) return;
        observer.disconnect(); reviewObservers.delete(String(chatId));
        if (String(globalThis.SillyTavern?.getContext?.()?.chatId || '') === String(chatId)) {
            void reviewPendingExtractionUpdates(chatId, options).catch(error => notify(`变更审核失败：${error.message}`, 'error'));
        }
    });
    reviewObservers.set(String(chatId), observer);
    observer.observe(document.documentElement, { childList: true, subtree: true });
}
