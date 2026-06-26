// api/_utils/groqAPI.js
const GROQ_MODELS = [
    "llama-3.1-8b-instant",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-guard-4-12b",
    "meta-llama/llama-prompt-guard-2-22m",
    "meta-llama/llama-prompt-guard-2-86m",
    "moonshotai/kimi-k2-instruct-0905"
];

/**
 * Shared, persistent model health ranking — same rationale as geminiAPI.js:
 * each call takes a local snapshot of the current ranking so concurrent
 * calls (e.g. under Promise.all) don't read/mutate the same array out from
 * under each other mid-flight. Failures still demote a model for future
 * calls, just not for calls already in progress.
 */
let modelRanking = [...GROQ_MODELS];

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

let modelUsage = {};

export function resetGroqModelUsage() {
    modelUsage = {};
}

export function getGroqModelUsage() {
    return { ...modelUsage };
}

function recordUsage(model, status) {
    if (!modelUsage[model]) {
        modelUsage[model] = { success: 0, failed: 0 };
    }
    modelUsage[model][status]++;
}

export const GroqAPI = {
    async chat(messages, apiKey, jsonMode = false) {
        if (!apiKey) throw new Error("Missing Groq API Key");

        const attemptOrder = snapshotRanking();
        let lastError = null;

        for (const model of attemptOrder) {
            const attemptStart = Date.now();
            try {
                const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${apiKey}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: messages,
                        temperature: 0.1,
                        response_format: jsonMode ? { type: "json_object" } : undefined
                    })
                });

                const data = await res.json();

                if (!res.ok) {
                    const errorMsg = data.error?.message || `Status ${res.status}`;

                    // If JSON mode fails (400), retry immediately with text mode —
                    // same model, not counted as a rotation failure.
                    if (res.status === 400 && jsonMode) {
                        return this.chat(messages, apiKey, false);
                    }

                    throw new Error(errorMsg);
                }

                if (!data.choices || !data.choices[0]) {
                    throw new Error("Invalid Groq response structure");
                }

                let content = data.choices[0].message.content;
                const elapsed = Date.now() - attemptStart;
                recordUsage(model, 'success');
                console.log(`[GroqAPI] model=${model} elapsed=${elapsed}ms status=success`);

                // Clean internal thought chains
                return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

            } catch (e) {
                const elapsed = Date.now() - attemptStart;
                recordUsage(model, 'failed');
                console.log(`[GroqAPI] model=${model} elapsed=${elapsed}ms status=failed error=${e.message}`);
                lastError = e;
                demoteModel(model);
            }
        }

        throw new Error(`AI Service Failed: ${lastError?.message}`);
    }
};
