/**
 * Secondary API communication module.
 * Supports OpenAI-compatible chat completion endpoints.
 */

const API_TIMEOUT_MS = 60000;

/**
 * @typedef {Object} ApiSettings
 * @property {string} apiUrl   - Full endpoint URL (e.g. https://api.openai.com/v1/chat/completions)
 * @property {string} apiKey   - Bearer token
 * @property {string} model    - Model name (e.g. gpt-4o-mini)
 * @property {number} [temperature=0.3]
 * @property {number} [maxTokens=512]
 */

/**
 * Call a secondary OpenAI-compatible chat completion API.
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {ApiSettings} settings
 * @returns {Promise<string>} The assistant's reply text
 */
export async function callSecondaryAPI(messages, settings) {
    if (!settings.apiUrl || !settings.apiKey || !settings.model) {
        throw new Error('[SmartMemory] Secondary API is not configured.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
        const response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`,
            },
            body: JSON.stringify({
                model: settings.model,
                messages,
                temperature: settings.temperature ?? 0.3,
                max_tokens: settings.maxTokens ?? 512,
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            throw new Error(`API returned ${response.status}: ${errorBody}`);
        }

        const data = await response.json();

        if (!data.choices?.[0]?.message?.content) {
            throw new Error('Unexpected API response structure');
        }

        return data.choices[0].message.content.trim();
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Test connectivity to the secondary API.
 * @param {ApiSettings} settings
 * @returns {Promise<{success:boolean, message:string}>}
 */
export async function testConnection(settings) {
    try {
        const reply = await callSecondaryAPI(
            [{ role: 'user', content: 'Reply with "OK" only.' }],
            settings,
        );
        return { success: true, message: `Connection OK. Reply: ${reply}` };
    } catch (err) {
        return { success: false, message: err.message };
    }
}
