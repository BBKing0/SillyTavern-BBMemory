/** Shared tag checks for retrieval and extraction updates. */
export function isDailyMemory(entry) {
    return (Array.isArray(entry?.tags) ? entry.tags : []).some(tag =>
        String(typeof tag === 'string' ? tag : tag?.name || '').trim() === '\u65e5\u5e38'
    );
}
