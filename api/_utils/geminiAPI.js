// api/_utils/geminiAPI.js
const GEMINI_MODELS = [
  'gemma-4-31b-it',
  'gemma-4-26b-A4b-it',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
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

    // Join only the parts that are NOT marked as 'thought'
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
 * Shared, persistent model health ranking.
 * Unlike a per-call local copy (which forgets failures the moment the call ends),
 * this module-level ranking is intentionally persistent ACROSS calls within the
 * same warm function instance — so a model that just failed moves to the back
 * for everyone, and a model that keeps succeeding stays at the front.
 *
 * The bug this fixes: the OLD code mutated GEMINI_MODELS itself with .push/.shift,
 * which had the same "shared across calls" effect but used the literal array
 * Promise chains were reading from concurrently — under Promise.all() with several
 * chat() calls in flight at once (e.g. digest's batched call racing against write's
 * call), two calls could read GEMINI_MODELS mid-mutation by another call, causing
 * inconsistent attempt order and double-counted rotations. This version takes an
 * explicit LOCAL SNAPSHOT of the current ranking at the start of each call, so each
 * call's retry loop is self-contained and deterministic regardless of what else is
 * running concurrently. Failures still update the shared ranking for the NEXT call,
 * just not for calls already in flight.
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
            return parseCleanResponse(data);

        } catch (e) {
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
