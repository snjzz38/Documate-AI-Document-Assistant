// api/_utils/geminiAPI.js
const GEMINI_MODELS = [
  'gemma-4-31b-it',
  'gemini-3.1-flash-lite-preview',
  'gemma-4-26b-a4b-it',
  'gemma-3-27b-it',
  'gemma-4-e4b-it',
  'gemma-4-e2b-it',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemma-3-12b-it',
  'gemma-3-4b-it',
  'gemma-3n-e2b-it',
  'gemma-3-1b-it'
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

export const GeminiAPI = {
    async chat(promptText, apiKey, temperature = 0.7) {
        if (!apiKey) throw new Error("Missing Gemini API Key");
        let lastError = null;

        for (let attempt = 0; attempt < GEMINI_MODELS.length; attempt++) {
            const currentModel = GEMINI_MODELS[0];
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`;
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        system_instruction: SYSTEM_INSTRUCTION,
                        contents: [{ parts: [{ text: promptText }] }],
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
                // Move failed model to the end of the list
                GEMINI_MODELS.push(GEMINI_MODELS.shift());
            }
        }
        throw new Error(`All models failed. Last error: ${lastError?.message}`);
    },

    async vision(promptText, apiKey, files = [], temperature = 0.7) {
        if (!apiKey) throw new Error("Missing Gemini API Key");
        let lastError = null;

        const contentParts = [
            ...files.map(f => ({
                inline_data: { mime_type: f.type, data: f.data }
            })),
            { text: promptText }
        ];

        for (let attempt = 0; attempt < GEMINI_MODELS.length; attempt++) {
            const currentModel = GEMINI_MODELS[0];
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`;
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
                GEMINI_MODELS.push(GEMINI_MODELS.shift());
            }
        }
        throw new Error(`All models failed. Last error: ${lastError?.message}`);
    }
};
