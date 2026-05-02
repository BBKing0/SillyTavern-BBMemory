/**
 * Message summarization and tag generation via the secondary API.
 *
 * Flow:  raw message → summarize → extract tags → build MemoryEntry
 */

import { callSecondaryAPI } from './api.js';
import { createMemoryEntry, makeExcerpt, RP_CATEGORIES, EMOTION_LABELS } from './memory-entry.js';

// ─── Prompt Templates ─────────────────────────────────────

const SUMMARIZE_SYSTEM = `You are a concise summarization assistant for a roleplay chat.
Summarize the given message in 1-2 short sentences, preserving key facts, character actions, emotional states, and any commitments or promises made.
Write in third person. Be factual and brief.`;

const TAG_SYSTEM = `You are a tagging assistant for a roleplay memory system.
Given a message summary, output a JSON object with exactly these fields:
{
  "keywords": ["keyword1", "keyword2", ...],
  "emotions": ["emotion1"],
  "categories": ["category1"],
  "importance": 5,
  "emotionalIntensity": 0.5
}

Rules:
- "keywords": 3-6 concise keyword tags capturing the core content.
- "emotions": Pick the most prominent emotion from: ${EMOTION_LABELS.join(', ')}. Can be empty array if truly neutral.
- "categories": Pick 1-2 from: ${RP_CATEGORIES.join(', ')}. Pick what fits best.
- "importance": Integer 1-10. 1=trivial small talk, 5=normal, 8=significant event, 10=critical turning point.
- "emotionalIntensity": Float 0.0-1.0. How emotionally charged is this memory? 0=neutral/factual, 0.5=moderate, 1.0=extremely intense.

Output ONLY the JSON object, no markdown fences, no explanation.`;

const QUERY_TAG_SYSTEM = `You are a keyword extraction assistant.
Given a user's chat message, extract 3-5 keywords that capture what the user is talking about or asking about.
Output ONLY the keywords as a comma-separated list, nothing else.`;

// ─── Functions ────────────────────────────────────────────

/**
 * Summarize a single message.
 * @param {string} messageText
 * @param {import('./api.js').ApiSettings} apiSettings
 * @param {Object} [promptConfig]
 * @param {string} [promptConfig.customPrompt]        - Full override (replaces default)
 * @param {string} [promptConfig.globalDirective]      - Appended to default prompt
 * @returns {Promise<string>}
 */
export async function summarizeMessage(messageText, apiSettings, promptConfig = {}) {
    let systemPrompt;
    if (typeof promptConfig === 'string') {
        systemPrompt = promptConfig || SUMMARIZE_SYSTEM;
    } else {
        systemPrompt = promptConfig.customPrompt || SUMMARIZE_SYSTEM;
        if (promptConfig.globalDirective) {
            systemPrompt += '\n\nAdditional instructions:\n' + promptConfig.globalDirective;
        }
    }
    return callSecondaryAPI(
        [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: messageText },
        ],
        apiSettings,
    );
}

/**
 * Generate structured tags from a summary.
 * @param {string} summary
 * @param {import('./api.js').ApiSettings} apiSettings
 * @param {Object} [promptConfig]
 * @param {string} [promptConfig.globalTagDirective]   - Extra rules appended to tag prompt
 * @param {string} [promptConfig.importanceCriteria]   - Custom importance scoring guidance
 * @returns {Promise<{keywords:string[], emotions:string[], categories:string[], importance:number, emotionalIntensity:number}>}
 */
export async function generateTags(summary, apiSettings, promptConfig = {}) {
    let tagPrompt = TAG_SYSTEM;
    if (promptConfig.globalTagDirective) {
        tagPrompt += '\n\nAdditional tagging rules:\n' + promptConfig.globalTagDirective;
    }
    if (promptConfig.importanceCriteria) {
        tagPrompt += '\n\nImportance scoring criteria:\n' + promptConfig.importanceCriteria;
    }

    const raw = await callSecondaryAPI(
        [
            { role: 'system', content: tagPrompt },
            { role: 'user', content: summary },
        ],
        apiSettings,
    );

    try {
        const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const parsed = JSON.parse(cleaned);
        return {
            keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
            emotions: Array.isArray(parsed.emotions) ? parsed.emotions.map(String) : [],
            categories: Array.isArray(parsed.categories) ? parsed.categories.map(String) : [],
            importance: Math.max(1, Math.min(10, parseInt(parsed.importance, 10) || 5)),
            emotionalIntensity: Math.max(0, Math.min(1, parseFloat(parsed.emotionalIntensity) || 0)),
        };
    } catch {
        console.warn('[SmartMemory] Failed to parse tag response, extracting keywords from raw text:', raw);
        const keywords = raw.split(/[,，\n]/).map(s => s.trim()).filter(Boolean).slice(0, 6);
        return { keywords, emotions: [], categories: [], importance: 5, emotionalIntensity: 0 };
    }
}

/**
 * Extract query keywords from a user message (for retrieval).
 * @param {string} userMessage
 * @param {import('./api.js').ApiSettings} apiSettings
 * @returns {Promise<string[]>}
 */
export async function extractQueryKeywords(userMessage, apiSettings) {
    const raw = await callSecondaryAPI(
        [
            { role: 'system', content: QUERY_TAG_SYSTEM },
            { role: 'user', content: userMessage },
        ],
        apiSettings,
    );
    return raw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
}

/**
 * Full pipeline: summarize + tag + create a MemoryEntry.
 *
 * @param {Object} params
 * @param {string} params.messageText    - Raw message content
 * @param {number} params.messageIndex   - Index in chat array
 * @param {string} params.chatId
 * @param {'user'|'assistant'} params.source
 * @param {import('./api.js').ApiSettings} params.apiSettings
 * @param {string} [params.customSummarizePrompt]   - Full override for summarization prompt
 * @param {string} [params.globalSummarizeDirective] - Appended directive for summarization
 * @param {string} [params.globalTagDirective]       - Appended directive for tagging
 * @param {string} [params.importanceCriteria]       - Custom importance scoring guidance
 * @returns {Promise<MemoryEntry>}
 */
export async function processMessage({
    messageText,
    messageIndex,
    chatId,
    source,
    apiSettings,
    customSummarizePrompt,
    globalSummarizeDirective,
    globalTagDirective,
    importanceCriteria,
}) {
    const summary = await summarizeMessage(messageText, apiSettings, {
        customPrompt: customSummarizePrompt,
        globalDirective: globalSummarizeDirective,
    });
    const tags = await generateTags(summary, apiSettings, {
        globalTagDirective,
        importanceCriteria,
    });

    return createMemoryEntry({
        messageIndex,
        chatId,
        summary,
        originalExcerpt: makeExcerpt(messageText),
        tags,
        importance: tags.importance,
        emotionalIntensity: tags.emotionalIntensity ?? 0,
        source,
    });
}
