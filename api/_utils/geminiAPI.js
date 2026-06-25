// api/_utils/geminiAPI.js
//
// Model order matters: fastest/cheapest first. Gemma 4 models include a
// mandatory "thinking" reasoning step (see Google's Gemma 4 docs) which
// makes them meaningfully slower per call than plain Gemini Flash-Lite —
// they're kept in rotation as capable fallbacks, just placed AFTER the
// fast models so a slow Gemma call doesn't become every call's first attempt.
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
  'gemini-3.1-pro-preview'
];

/**
 * Filters the API response to remove internal reasoning/thought parts.
 * This is more robust than regex because it uses the API's own metadata.
 */
const parseCleanResponse = (data) => {
    if (!data.candidates?.[0]?.content?.parts) {
        throw new Error("Invalid response structure from Gemini");
    }

    const parts = data.candidates[0].content.parts;
    const cleanText = parts
        .filter(part => !part.thought)
        .map(part => part.text || "")
        .join("")
        .trim();

    return cleanText;
};

const SYSTEM_INSTRUCTION = {
    parts: [{
        text: "You are a direct assistant. NEVER include internal monologue, chain-of-thought, or narration of your reasoning. Respond only with the final output. Do not say 'The user said...' or 'I will now...'."
    }]
};

/**
 * Shared, persistent model health ranking — see callGemini for the
 * snapshot-per-call rationale that avoids cross-call race conditions.
 */
let modelRanking = [...GEMINI_MODELS];

function snapshotRanking() {
    return [...modelRanking];
}

function demoteModel(model) {
    const idx = modelRanking.indexOf(model);
    if (idx !== -1) {
        modelRanking.splice(idx, 1);
        modelRanking.push(model);
    }
}

async function callGemini(promptText, apiKey, temperature, contentParts) {
    if (!apiKey) throw new Error("Missing Gemini API Key");

    const attemptOrder = snapshotRanking();
    let lastError = null;

    for (const model of attemptOrder) {
        const attemptStart = Date.now();
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    system_instruction: SYSTEM_INSTRUCTION,
                    contents: [{ parts: contentParts }],
                    generationConfig: { temperature, topP: 0.95 }
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error?.message || `Status ${res.status}`);
            }

            const data = await res.json();
            const elapsed = Date.now() - attemptStart;
            console.log(`[GeminiAPI] model=${model} elapsed=${elapsed}ms status=success`);
            return parseCleanResponse(data);

        } catch (e) {
            const elapsed = Date.now() - attemptStart;
            console.log(`[GeminiAPI] model=${model} elapsed=${elapsed}ms status=failed error=${e.message}`);
            lastError = e;
            demoteModel(model);
        }
    }
    throw new Error(`All models failed. Last error: ${lastError?.message}`);
}

export const GeminiAPI = {
    async chat(promptText, apiKey, temperature = 0.7) {
        return callGemini(promptText, apiKey, temperature, [{ text: promptText }]);
    },

    async vision(promptText, apiKey, files = [], temperature = 0.7) {
        const contentParts = [
            ...files.map(f => ({
                inline_data: { mime_type: f.type, data: f.data }
            })),
            { text: promptText }
        ];
        return callGemini(promptText, apiKey, temperature, contentParts);
    }
};
