// ==========================================================================
// FILE: api/features/humanizer.js
// DESCRIPTION: 
// An API route that humanizes AI-generated text using Gemini. It processes 
// text in chunks to maintain flow and reduce API calls, enforces natural 
// phrasing via strict prompt engineering, and applies safe post-processing.
// ==========================================================================

/* 
// ==========================================================================
// TABLE OF CONTENTS
// ==========================================================================
1. CONFIGURATION & CONSTANTS
   - AI_VOCAB_SWAPS: Dictionary of formal/AI words to natural words.
   
2. TEXT UTILITIES MODULE
   - splitIntoChunks(): Safely splits text into sentence groups.
   - applyWordSwaps(): Case-preserving replacement of banned words.
   
3. PROMPT ENGINEERING MODULE
   - buildChunkPrompt(): Constructs the LLM prompt with strict humanizing rules.
   
4. LLM SERVICE MODULE
   - humanizeChunk(): Handles the API call to Gemini with safe temperature.
   
5. POST-PROCESSING MODULE
   - postProcess(): Light, safe cleanup of punctuation (Em-dash banning).
   
6. API HANDLER
   - handler(): Main entry point orchestrating the modules.
// ==========================================================================
*/

import { GeminiAPI } from '../_utils/geminiAPI.js';

// ==========================================================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================================================

const AI_VOCAB_SWAPS = {
    "utilize": "use", "utilizes": "uses", "utilizing": "using", "utilized": "used",
    "leverage": "use", "leverages": "uses", "leveraging": "using", "leveraged": "used",
    "facilitate": "help", "facilitates": "helps", "facilitating": "helping",
    "optimize": "improve", "optimizes": "improves", "optimizing": "improving",
    "necessitate": "require", "necessitates": "requires", "necessitating": "requiring",
    "exacerbate": "worsen", "exacerbates": "worsens", "exacerbating": "worsening", "exacerbated": "worsened",
    "mitigate": "reduce", "mitigates": "reduces", "mitigating": "reducing",
    "fundamental": "basic", "fundamentally": "basically",
    "comprehensive": "full", "comprehensively": "fully",
    "robust": "strong", "robustly": "strongly",
    "furthermore": "also", "moreover": "also", "additionally": "also",
    "consequently": "so", "nevertheless": "but", "therefore": "so",
    "thus": "so", "hence": "so", "whereby": "where",
    "crucial": "important", "essential": "needed", "significant": "major",
    "substantial": "large", "numerous": "many", "prudent": "wise"
};


// ==========================================================================
// 2. TEXT UTILITIES MODULE
// ==========================================================================

/**
 * Splits text into chunks of sentences without breaking on common abbreviations.
 * @param {string} text - The input text.
 * @param {number} sentencesPerChunk - How many sentences to group per API call.
 * @returns {string[]} Array of text chunks.
 */
function splitIntoChunks(text, sentencesPerChunk = 4) {
    // Matches sentence endings, ignoring common abbreviations like Mr., Dr., U.S.
    const sentenceRegex = /[^.!?]+[.!?]+(?=\s|$|\n)/g;
    const sentences = text.match(sentenceRegex) || [text];
    
    const chunks = [];
    for (let i = 0; i < sentences.length; i += sentencesPerChunk) {
        chunks.push(sentences.slice(i, i + sentencesPerChunk).join(' ').trim());
    }
    return chunks.filter(c => c.length > 0);
}

/**
 * Replaces banned AI words while preserving the original capitalization.
 * @param {string} text - The text to process.
 * @returns {string} Processed text.
 */
function applyWordSwaps(text) {
    let result = text;
    for (const [bad, good] of Object.entries(AI_VOCAB_SWAPS)) {
        const regex = new RegExp(`\\b${bad}\\b`, 'gi');
        result = result.replace(regex, (match) => {
            if (match[0] === match[0].toUpperCase()) {
                return good.charAt(0).toUpperCase() + good.slice(1);
            }
            return good;
        });
    }
    return result;
}


// ==========================================================================
// 3. PROMPT ENGINEERING MODULE
// ==========================================================================

/**
 * Builds a highly constrained prompt for naturalizing a chunk of text.
 * @param {string} chunk - The text chunk to rewrite.
 * @returns {string} The formatted prompt.
 */
function buildChunkPrompt(chunk) {
    return `Rewrite the following text so it sounds like a human wrote it. Keep the exact same meaning. MATCH THE ORIGINAL TONE (if it is academic, keep it academic; do not make it conversational, informal, or add rhetorical questions).

TEXT TO REWRITE:
"${chunk}"

STRICT RULES:
1. Output ONLY the rewritten text. No commentary, no quotes around the output.
2. BURSTINESS IS MANDATORY: Drastically vary sentence lengths. Mix very short, direct sentences with longer ones. Do not use a uniform, metronomic rhythm.
3. NEVER use lists of three items. Use two items joined by "and", or use separate sentences.
4. NEVER use semicolons (;) or em dashes (— or -).
5. NEVER use ", which" relative clauses. Use separate sentences instead.
6. NEVER use the "Not X. It is not Y. It is Z." sentence structure. Do not use repeated negations to make a point.
7. BANNED WORDS/PHRASES: "regarding", "represents", "abstract cognitive tools", "artificial logic exercise", "societal organization", "persist outside the mind", "limitless sequence", "dynamic interplay", "fabric of the universe".
8. Do NOT write like a textbook or an encyclopedia. Write like a human expert explaining a concept clearly and directly. 
9. Do NOT use formulaic transitions like "Some scholars argue", "This perspective suggests", or "A combination of these perspectives". Just state the idea directly.
10. NEVER use filler phrases like "essentially", "it should be noted", or "as a matter of course".
11. Use contractions naturally ONLY if the original text uses them or if the tone is casual.

Output ONLY the rewritten text:`;
}



// ==========================================================================
// 4. LLM SERVICE MODULE
// ==========================================================================

/**
 * Calls the Gemini API to humanize a specific chunk of text.
 * @param {string} chunk - The text chunk.
 * @param {string} apiKey - The Gemini API key.
 * @param {number} temperature - LLM temperature.
 * @returns {Promise<string>} Humanized chunk.
 */
async function humanizeChunk(chunk, apiKey, temperature) {
    const prompt = buildChunkPrompt(chunk);
    const raw = await GeminiAPI.chat(prompt, apiKey, temperature);
    
    // Clean up potential quotes or formatting LLM might add
    return raw.trim().replace(/^["']|["']$/g, '');
}


// ==========================================================================
// 5. POST-PROCESSING MODULE
// ==========================================================================

// Dictionary of sterile AI words to flatten into natural language
const AI_STERILE_SWAPS = {
    "regarding": "about",
    "represents a": "is a",
    "represents an": "is an",
    "represents the": "is the",
    "represents": "is",
    "abstract cognitive tools": "mental tools",
    "artificial logic exercise": "logic exercise",
    "societal organization": "organizing society",
    "limitless sequence": "endless sequence",
    "persist outside the mind": "exist outside the mind"
};

/**
 * Performs light, safe cleanup on the final combined text.
 * Acts as a safety net for em-dashes, sterile vocabulary, and formatting.
 * @param {string} text - The fully humanized text.
 * @returns {string} Cleaned text.
 */
function postProcess(text) {
    let result = text;

    // Normalize quotes/apostrophes
    result = result.replace(/[''`´]/g, "'");
    result = result.replace(/[""„]/g, '"');

    // ===========================================
    // STRICT EM-DASH BANNING
    // ===========================================
    result = result.replace(/\s*\u2014\s*|\s*\u2013\s*|\s*--\s*/g, ', ');
    result = result.replace(/,\s*,/g, ',');

    // ===========================================
    // STERILE VOCABULARY SWAPS (Safety Net)
    // ===========================================
    for (const [bad, good] of Object.entries(AI_STERILE_SWAPS)) {
        const regex = new RegExp(`\\b${bad}\\b`, 'gi');
        result = result.replace(regex, (match) => {
            if (match[0] === match[0].toUpperCase()) {
                return good.charAt(0).toUpperCase() + good.slice(1);
            }
            return good;
        });
    }

    // Fix missing space after comma/period (basic formatting)
    result = result.replace(/,([a-zA-Z])/g, ', $1');
    result = result.replace(/\.([a-zA-Z])/g, '. $1');

    // Ensure single space between sentences
    result = result.replace(/\s{2,}/g, ' ');

    // Capitalize first letter of every sentence
    result = result.replace(/([.!?]\s+)([a-z])/g, (m, punct, letter) => `${punct}${letter.toUpperCase()}`);
    
    // Ensure very first letter is capitalized
    result = result.replace(/^([a-z])/, (m, letter) => letter.toUpperCase());

    return result.trim();
}


// ==========================================================================
// 6. GROQ SANITY CHECKER MODULE (NEW)
// ==========================================================================

/**
 * Uses Groq (Llama 3) to semantically scan for stubborn AI patterns and 
 * return JSON fixes. This replaces fragile regex post-processing.
 * @param {string} text - The humanized text to check.
 * @param {string} groqKey - Groq API Key.
 * @returns {Promise<{text: string, fixes: array}>} The cleaned text and applied fixes.
 */
async function groqSanityCheck(text, groqKey) {
    const prompt = `You are a strict post-processing engine. Analyze the provided text for any lingering AI artifacts. 

Find and fix these specific issues:
1. Em dashes (— or -) or semicolons (;).
2. Lists of three items (e.g., "A, B, and C"). Reduce them to two items or split into two sentences.
3. "Not X. It is not Y. It is Z." repetitive negation structures.
4. Cliché AI phrases ("fabric of the universe", "dynamic interplay", "vast horizon").
5. "Isn't X, it's Y" sentence structures.

Return a JSON object with a key "fixes" containing an array of objects. Each object must have "target" (the exact problematic sentence) and "replacement" (the fixed sentence). 
If there are no issues, return {"fixes": []}.

TEXT TO ANALYZE:
 ${text}

JSON OUTPUT:`;

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama3-8b-8192', // Fast and capable for this task
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2, // Low temp for deterministic output
                response_format: { type: 'json_object' } // Force JSON
            })
        });

        const data = await response.json();
        const content = data.choices[0].message.content;
        const parsed = JSON.parse(content);

        let cleanText = text;
        const appliedFixes = [];

        // Apply the fixes safely
        if (parsed.fixes && parsed.fixes.length > 0) {
            for (const fix of parsed.fixes) {
                // Escape regex characters in the target string for safe replacement
                const escapedTarget = fix.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedTarget, 'gi');
                
                if (regex.test(cleanText)) {
                    cleanText = cleanText.replace(regex, fix.replacement);
                    appliedFixes.push(fix);
                }
            }
        }

        return { text: cleanText, fixes: appliedFixes };
    } catch (error) {
        console.error('Groq Sanity Check Failed:', error);
        return { text, fixes: [] }; // Fail gracefully, return original text
    }
}

// ==========================================================================
// 7. API HANDLER (UPDATED)
// ==========================================================================

/**
 * Main API Route Handler
 * Orchestrates: Pre-processing -> Chunking -> Gemini -> Post-processing -> Groq Sanity Check
 */
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    const logs = [];

    try {
        const { text, apiKey, groqApiKey } = req.body;
        const GEMINI_KEY = apiKey || process.env.GEMINI_API_KEY;
        const GROQ_KEY = groqApiKey || process.env.GROQ_API_KEY;

        if (!text) throw new Error("No text provided.");
        if (!GEMINI_KEY) throw new Error("No Gemini API key provided.");

        logs.push(`Input: ${text.length} chars`);

        // Step 1: Initial word swaps on the full input
        let processed = applyWordSwaps(text);
        logs.push('Applied banned word replacements');

        // Step 2: Split into chunks
        const chunks = splitIntoChunks(processed, 4);
        logs.push(`Split into ${chunks.length} chunks`);

        const temperature = 0.7 + Math.random() * 0.3;
        logs.push(`Temperature: ${temperature.toFixed(2)}`);

        // Step 3: Humanize chunks sequentially
        const humanizedChunks = [];
        for (let i = 0; i < chunks.length; i++) {
            try {
                const humanized = await humanizeChunk(chunks[i], GEMINI_KEY, temperature);
                humanizedChunks.push(humanized);
                logs.push(`Chunk ${i + 1}/${chunks.length}: OK`);
            } catch (err) {
                logs.push(`Chunk ${i + 1}/${chunks.length}: FAILED, using original`);
                humanizedChunks.push(chunks[i]);
            }
        }

        // Step 4: Rejoin and initial regex post-process
        let result = humanizedChunks.join(' ');
        result = postProcess(result);
        logs.push('Applied regex post-processing');

        // Step 5: Groq Semantic Sanity Check
        if (GROQ_KEY) {
            logs.push('Starting Groq sanity check...');
            const groqResult = await groqSanityCheck(result, GROQ_KEY);
            result = groqResult.text;
            logs.push(`Groq applied ${groqResult.fixes.length} semantic fixes.`);
        } else {
            logs.push('Skipped Groq sanity check (no API key provided).');
        }

        // Step 6: Final word swap pass
        result = applyWordSwaps(result);

        logs.push(`Final: ${result.length} chars`);

        return res.status(200).json({ success: true, result, logs });

    } catch (error) {
        logs.push(`ERROR: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message, logs });
    }
}



// Exporting modules for testing and external use
export { 
    postProcess as PostProcessor, 
    AI_VOCAB_SWAPS, 
    applyWordSwaps,
    splitIntoChunks
};
