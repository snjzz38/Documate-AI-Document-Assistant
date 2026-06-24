
// api/_utils/groqAPI.js

// NOTE: Smart quote fixed on the last line
const GROQ_MODELS = [
    "llama-3.1-8b-instant",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-guard-4-12b",
    "meta-llama/llama-prompt-guard-2-22m",
    "meta-llama/llama-prompt-guard-2-86m",
    "moonshotai/kimi-k2-instruct-0905" 
];

export const GroqAPI = {
    async chat(messages, apiKey, jsonMode = false) {
        if (!apiKey) throw new Error("Missing Groq API Key");

        let lastError = null;

        // Try every model once
        for (let i = 0; i < GROQ_MODELS.length; i++) {
            const currentModel = GROQ_MODELS[0];

            try {
                const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${apiKey}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: currentModel,
                        messages: messages,
                        temperature: 0.1,
                        response_format: jsonMode ? { type: "json_object" } : undefined
                    })
                });

                const data = await res.json();

                if (!res.ok) {
                    const errorMsg = data.error?.message || `Status ${res.status}`;
                    
                    // If JSON mode fails (400), retry immediate with text mode
                    if (res.status === 400 && jsonMode) {
                        return this.chat(messages, apiKey, false);
                    }
                    
                    throw new Error(errorMsg);
                }

                if (!data.choices || !data.choices[0]) {
                    throw new Error("Invalid Groq response structure");
                }

                let content = data.choices[0].message.content;
                
                // Clean internal thought chains
                return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

            } catch (e) {
                lastError = e;
                // ROTATION LOGIC: Move failed model to end
                const failed = GROQ_MODELS.shift();
                GROQ_MODELS.push(failed);
            }
        }

        throw new Error(`AI Service Failed: ${lastError?.message}`);
    }
};
