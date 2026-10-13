/** v9.5.1 时间线总结时间：仅用于管理 / 维护显示。 */
export function formatTimelineSummaryTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '尚未总结';
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '尚未总结';
    return date.toLocaleString('zh-CN', { hour12: false });
}
