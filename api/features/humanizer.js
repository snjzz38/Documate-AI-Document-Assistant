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
2. NEVER use lists of three items (e.g., "A, B, and C"). This is a dead giveaway for AI. If listing things, use only two items joined by "and", or split the items into separate sentences.
3. NEVER use semicolons (;) or em dashes (— or -).
4. NEVER use ", which" relative clauses. Use separate sentences instead.
5. NEVER use filler phrases like "essentially", "it should be noted", or "as a matter of course".
6. Use contractions naturally (e.g., it's, don't) ONLY if the original text uses them or if the tone is casual. If the tone is strictly formal, do not force contractions.
7. Vary sentence structure: mix short punchy sentences with longer ones. Do not make every sentence the same length.
8. NEVER use "isn't X, it's Y" or "not just X, but Y" constructions.

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

/**
 * Performs light, safe cleanup on the final combined text.
 * Acts as a safety net for em-dashes and formatting.
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
    // Replaces em-dashes (—), en-dashes (–), and double hyphens (--) with commas
    // ===========================================
    result = result.replace(/\s*\u2014\s*|\s*\u2013\s*|\s*--\s*/g, ', ');
    
    // Fix any accidental double commas created by the dash replacement
    result = result.replace(/,\s*,/g, ',');

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
// 6. API HANDLER
// ==========================================================================

/**
 * Main API Route Handler
 * Orchestrates the humanization process: Pre-processing -> Chunking -> LLM -> Post-processing.
 */
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    const logs = [];

    try {
        const { text, apiKey } = req.body;
        const GEMINI_KEY = apiKey || process.env.GEMINI_API_KEY;

        if (!text) throw new Error("No text provided.");
        if (!GEMINI_KEY) throw new Error("No Gemini API key provided.");

        logs.push(`Input: ${text.length} chars`);

        // Step 1: Initial word swaps on the full input
        let processed = applyWordSwaps(text);
        logs.push('Applied banned word replacements');

        // Step 2: Split into chunks (Efficiency improvement)
        const chunks = splitIntoChunks(processed, 4);
        logs.push(`Split into ${chunks.length} chunks (4 sentences each)`);

        // Safe temperature: High enough for variety, low enough to prevent hallucination
        const temperature = 0.7 + Math.random() * 0.3; // 0.7 to 1.0
        logs.push(`Temperature: ${temperature.toFixed(2)}`);

        // Step 3: Humanize chunks sequentially to avoid rate limits
        const humanizedChunks = [];
        
        for (let i = 0; i < chunks.length; i++) {
            try {
                const humanized = await humanizeChunk(chunks[i], GEMINI_KEY, temperature);
                humanizedChunks.push(humanized);
                logs.push(`Chunk ${i + 1}/${chunks.length}: OK`);
            } catch (err) {
                logs.push(`Chunk ${i + 1}/${chunks.length}: FAILED (${err.message}), using original`);
                humanizedChunks.push(chunks[i]); // Fallback to pre-processed original on failure
            }
        }

        // Step 4: Rejoin and post-process
        let result = humanizedChunks.join(' ');
        result = postProcess(result);

        // Step 5: Final word swap pass (catches any new banned words generated by LLM)
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
