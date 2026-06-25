// api/_utils/geminiAPI.js
//
// Model order: fastest first. Gemma 4 has a mandatory internal "thinking"
// step with no public API toggle as of this writing, so it's kept as a
// fallback rather than primary. Gemini 2.5 models support thinkingBudget=0
// to disable thinking outright for tasks that don't need deep reasoning.
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

const THINKING_BUDGET_MODELS = new Set([
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
]);

/**
 * Per-invocation model usage tracker. Reset at the start of each serverless
 * invocation (each cold/warm function call gets a fresh module load in most
 * cases, but since warm reuse can persist module state, callers should call
 * resetModelUsage() at the start of a run_swarm request to guarantee a clean
 * count for that specific request rather than accumulating across requests).
 */
let modelUsage = {};

export function resetModelUsage() {
    modelUsage = {};
}

export function getModelUsage() {
    return { ...modelUsage };
}

function recordUsage(model, status) {
    if (!modelUsage[model]) {
        modelUsage[model] = { success: 0, failed: 0 };
    }
    modelUsage[model][status]++;
}

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

function buildGenerationConfig(model, temperature, disableThinking) {
    const config = { temperature, topP: 0.95 };
    if (disableThinking && THINKING_BUDGET_MODELS.has(model)) {
        config.thinkingConfig = { thinkingBudget: 0 };
    }
    return config;
}

async function callGemini(promptText, apiKey, temperature, contentParts, disableThinking) {
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
                    generationConfig: buildGenerationConfig(model, temperature, disableThinking)
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error?.message || `Status ${res.status}`);
            }

            const data = await res.json();
            const elapsed = Date.now() - attemptStart;
            recordUsage(model, 'success');
            console.log(`[GeminiAPI] model=${model} elapsed=${elapsed}ms status=success thinkingDisabled=${disableThinking && THINKING_BUDGET_MODELS.has(model)}`);
            return parseCleanResponse(data);

        } catch (e) {
            const elapsed = Date.now() - attemptStart;
            recordUsage(model, 'failed');
            console.log(`[GeminiAPI] model=${model} elapsed=${elapsed}ms status=failed error=${e.message}`);
            lastError = e;
            demoteModel(model);
        }
    }
    throw new Error(`All models failed. Last error: ${lastError?.message}`);
}

export const GeminiAPI = {
    async chat(promptText, apiKey, temperature = 0.7, disableThinking = true) {
        return callGemini(promptText, apiKey, temperature, [{ text: promptText }], disableThinking);
    },

    async vision(promptText, apiKey, files = [], temperature = 0.7, disableThinking = true) {
        const contentParts = [
            ...files.map(f => ({
                inline_data: { mime_type: f.type, data: f.data }
            })),
            { text: promptText }
        ];
        return callGemini(promptText, apiKey, temperature, contentParts, disableThinking);
    }
};
