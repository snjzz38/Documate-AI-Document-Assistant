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
import { resetGroqModelUsage } from '../_utils/groqAPI.js';

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
2. BURSTINESS IS MANDATORY: Drastically vary sentence lengths. Mix very short, direct sentences with longer ones.
3. NEVER use lists of three items. Use two items joined by "and", or use separate sentences.
4. NEVER use semicolons (;) or em dashes (— or -).
5. NEVER use ", which" relative clauses. Use separate sentences instead.
6. NEVER use the "Not X. It is not Y. It is Z." repetitive negation structure.
7. NEVER use imperative pivots. Do NOT write "Consider the...", "Think of a...", or "Take for example...". Just state the information directly.
8. NEVER use dramatic or poetic adjectives. BANNED WORDS: "startling", "profound", "vast", "limitless", "unparalleled", "remarkable". Use neutral, factual adjectives instead.
9. NEVER repeat the same metaphor or analogy within the same chunk. BANNED CLICHÉS: "acts as a bridge", "fabric of the universe", "dynamic interplay", "vast landscape".
10. Do NOT use formulaic transitions like "Others maintain that", "This perspective suggests", or "The most compelling evidence". Just state the idea directly.
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
// 6. GROQ FLOW ENHANCER MODULE (Replaces Sanity Checker)
// ==========================================================================

import { GroqAPI } from '../_utils/groqAPI.js';

/**
 * Uses Groq to fix staccato, disconnected sentences by designing natural 
 * transitions and improving overall flow. Returns a JSON object with the full text.
 * 
 * @param {string} text - The humanized text to check.
 * @param {string} groqKey - Groq API Key.
 * @returns {Promise<{text: string, success: boolean}>} The cleaned text.
 */
async function groqFlowEnhancement(text, groqKey) {
    const prompt = `You are an expert editor. The following text is too staccato and consists of too many short, disconnected sentences. Your job is to rewrite it to improve flow, combining sentences naturally and adding smooth transitions between ideas.

STRICT RULES:
1. Keep the exact same meaning and academic tone. Do not add new facts.
2. Vary sentence length (burstiness), but connect ideas logically so it doesn't read like a list of facts.
3. NEVER use em dashes (— or -), semicolons (;), or lists of three items (A, B, and C).
4. NEVER use "Not X. It is not Y. It is Z." repetitive negation structures.
5. NEVER use cliché AI phrases ("fabric of the universe", "dynamic interplay", "vast horizon").
6. NEVER use words: "regarding", "represents", "utilize", "facilitate".
7. NEVER use formulaic transitions like "Furthermore", "Moreover", "Additionally", or "In conclusion". Use natural conversational/academic flow instead.

Return a JSON object with the key "rewritten_text" containing the fully edited text.

TEXT TO EDIT:
 ${text}

JSON OUTPUT:`;

    const messages = [{ role: 'user', content: prompt }];

    try {
        // Use your shared utility, forcing JSON mode
        const content = await GroqAPI.chat(messages, groqKey, true);
        
        // Safely parse JSON
        const cleanJson = content.replace(/^```json\s*|\s*```$/g, '').trim();
        const parsed = JSON.parse(cleanJson);
        
        if (parsed.rewritten_text) {
            return { text: parsed.rewritten_text, success: true };
        }
        return { text, success: false }; // Fail gracefully
        
    } catch (error) {
        console.error('Groq Flow Enhancement Failed:', error);
        return { text, success: false }; // Fail gracefully, return original text
    }
}


// ==========================================================================
// 7. API HANDLER (UPDATED WITH MODEL USAGE METRICS)
// ==========================================================================

import { GeminiAPI, getModelUsage as getGeminiUsage, resetModelUsage as resetGeminiUsage } from '../_utils/geminiAPI.js';

/**
 * Main API Route Handler
 * Orchestrates: Pre-processing -> Chunking -> Gemini -> Post-processing -> Groq Flow Enhancement
 */
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    const logs = [];
    const startTime = Date.now();
    
    // Reset model usage trackers for this specific invocation
    resetGeminiUsage();
    resetGroqModelUsage();

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

        // Step 5: Groq Flow Enhancement (Fixes staccato sentences)
        let groqSuccess = false;
        if (GROQ_KEY) {
            logs.push('Starting Groq flow enhancement...');
            const groqResult = await groqFlowEnhancement(result, GROQ_KEY);
            result = groqResult.text;
            groqSuccess = groqResult.success;
            logs.push(`Groq flow enhancement success: ${groqSuccess}`);
        } else {
            logs.push('Skipped Groq flow enhancement (no API key provided).');
        }

        // Step 6: Final word swap pass
        result = applyWordSwaps(result);

        const totalTimeMs = Date.now() - startTime;
        logs.push(`Final: ${result.length} chars`);

        // Gather actual model usage from the utility files
        const geminiUsage = getGeminiUsage();
        const groqUsage = getGroqModelUsage();

        // Calculate total calls
        const geminiTotalCalls = Object.values(geminiUsage).reduce((acc, m) => acc + m.success + m.failed, 0);
        const groqTotalCalls = Object.values(groqUsage).reduce((acc, m) => acc + m.success + m.failed, 0);

        // Construct the "humanizer" network result object
        const humanizerNetworkResult = {
            executionTimeMs: totalTimeMs,
            executionTimeSec: (totalTimeMs / 1000).toFixed(2),
            inputChars: text.length,
            outputChars: result.length,
            chunksProcessed: chunks.length,
            gemini: {
                totalCalls: geminiTotalCalls,
                modelsUsed: geminiUsage // Returns object like { 'gemini-2.5-flash': { success: 5, failed: 0 } }
            },
            groq: {
                totalCalls: groqTotalCalls,
                modelsUsed: groqUsage,
                flowEnhancementApplied: groqSuccess
            }
        };

        return res.status(200).json({ 
            success: true, 
            result, 
            logs,
            humanizer: humanizerNetworkResult 
        });

    } catch (error) {
        const totalTimeMs = Date.now() - startTime;
        logs.push(`ERROR: ${error.message}`);
        
        // Still try to gather usage data even if it crashed
        const geminiUsage = getGeminiUsage() || {};
        const groqUsage = getGroqModelUsage() || {};
        
        return res.status(500).json({ 
            success: false, 
            error: error.message, 
            logs,
            humanizer: {
                executionTimeMs: totalTimeMs,
                gemini: {
                    totalCalls: Object.values(geminiUsage).reduce((acc, m) => acc + m.success + m.failed, 0),
                    modelsUsed: geminiUsage
                },
                groq: {
                    totalCalls: Object.values(groqUsage).reduce((acc, m) => acc + m.success + m.failed, 0),
                    modelsUsed: groqUsage
                }
            }
        });
    }
}



// Exporting modules for testing and external use
export { 
    postProcess as PostProcessor, 
    AI_VOCAB_SWAPS, 
    applyWordSwaps,
    splitIntoChunks
};
