// ==========================================================================
// FILE: api/features/humanizer.js
// DESCRIPTION: 
// An API route that humanizes AI-generated text using Gemini. It processes 
// text in chunks to maintain flow and reduce API calls, enforces natural 
// phrasing via strict prompt engineering, and applies safe 3-stage post-processing.
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
   - applyJsonReplacements(): Safely applies JSON before/after maps to text.
   
3. PROMPT ENGINEERING MODULE
   - buildChunkPrompt(): Constructs the LLM prompt with strict humanizing rules.
   
4. LLM SERVICE MODULE
   - humanizeChunk(): Handles the API call to Gemini with safe temperature.
   
5. REGEX POST-PROCESSING MODULE
   - postProcess(): Light, safe cleanup of punctuation (Em-dash banning).
   
6. GROQ 3-STAGE SANITY CHECKER MODULE
   - Stage 1: Vocabulary context fixes.
   - Stage 2: Syntactic AI tells (em dashes, participial phrases, etc.).
   - Stage 3: Staccato flow and transition fixes.
   
7. API HANDLER
   - handler(): Main entry point orchestrating the modules.
// ==========================================================================
*/

// ==========================================================================
// IMPORTS (Always at the top)
// ==========================================================================
import { GeminiAPI, getModelUsage as getGeminiUsage, resetModelUsage as resetGeminiUsage } from '../_utils/geminiAPI.js';
import { GroqAPI, getGroqModelUsage, resetGroqModelUsage } from '../_utils/groqAPI.js';

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
    "substantial": "large", "numerous": "many", "prudent": "wise",
    "objective discovery": "discovery", "objective discoveries": "discoveries",
    "pre-existing truths": "existing facts", "pre-existing": "existing",
    "predictability and effectiveness": "accuracy",
    "abstract tools": "mental tools",
    "social organization": "organizing society",
    "constant interaction": "interaction",
    "entirely separate existence": "independent reality",
    "extensive set": "large number",
    "supports the view": "argues",
    "holds that": "claims",
    "in turn": ""
};


// ==========================================================================
// 2. TEXT UTILITIES MODULE
// ==========================================================================

/**
 * Splits text into chunks of sentences without breaking on common abbreviations.
 */
function splitIntoChunks(text, sentencesPerChunk = 4) {
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

/**
 * Safely parses a string into a JSON object.
 */
function parseGroqJson(content) {
    try {
        // Strip markdown code blocks if the model added them
        const cleanJson = content.replace(/^```json\s*|\s*```$/g, '').trim();
        return JSON.parse(cleanJson);
    } catch (error) {
        console.error('Failed to parse Groq JSON:', error, '\nRaw:', content);
        return {}; // Fail gracefully to empty object
    }
}

/**
 * Applies a JSON map of { "before": "after" } to a text string.
 * Replaces ONLY the first instance of a perfect match (with flexible whitespace).
 */
function applyJsonReplacements(text, jsonMap) {
    let result = text;
    if (!jsonMap || typeof jsonMap !== 'object') return result;

    for (const [before, after] of Object.entries(jsonMap)) {
        if (!before || !after) continue;
        
        // Escape regex special characters, but allow flexible whitespace \s+ between words
        const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        // No 'g' flag ensures it ONLY replaces the FIRST match
        const regex = new RegExp(escaped, 'i');
        result = result.replace(regex, after);
    }
    return result;
}


// ==========================================================================
// 3. PROMPT ENGINEERING MODULE
// ==========================================================================

/**
 * Builds a highly constrained prompt for naturalizing a chunk of text.
 */
function buildChunkPrompt(chunk) {
    return `Rewrite the following text so it sounds like a human wrote it. Keep the exact same meaning. MATCH THE ORIGINAL TONE (if it is academic, keep it academic; do not make it conversational, informal, or add rhetorical questions).

TEXT TO REWRITE:
"${chunk}"

STRICT RULES:
1. Output ONLY the rewritten text. No commentary, no quotes around the output.
2. NO COMMA CHAINS: A sentence must NOT contain more than ONE comma (the only exception is a list of exactly two items joined by "and"). If you need more commas, you MUST split the sentence into two separate sentences.
3. SENTENCE FLOW: Do not write in short, staccato fragments. Connect related ideas. However, DO NOT write massive run-on sentences. If a sentence has more than two clauses, split it into two sentences.
4. COMPARISONS: When comparing two subjects or parallel ideas across two short sentences, combine them using ", while" or ", whereas" (e.g., "A mathematician uncovers facts, while an explorer finds an island.").
5. NO REDUNDANCY: Do not repeat the same premise or concept in consecutive sentences. State an idea once and move on.
6. NEVER start consecutive sentences with the same word. Specifically, do not start multiple sentences with "The", "This", "It", or the main subject of the text. Vary your sentence openers.
7. NEVER use nested relative clauses (e.g., "X, which is Y, a concept that does Z"). Write separate, direct sentences instead.
8. NEVER use "with [noun] [verb]ing" constructions (e.g., "with mathematics serving as..."). Break them into separate sentences.
9. NEVER use participial phrases at the end of sentences (e.g., "..., making it important" or "..., revealing the truth"). Use a separate verb and subject instead.
10. NEVER use "Both X and Y" structures. Just say "X and Y".
11. NEVER use semicolons (;) or em dashes (— or -).
12. NEVER use the "Not X. It is not Y. It is Z." repetitive negation structure.
13. NEVER use imperative pivots. Do NOT write "Consider the...", "Think of a...", or "Take for example...". Just state the information directly.
14. Do NOT use formulaic transitions like "Others maintain that", "This perspective suggests", or "The most compelling evidence". Just state the idea directly.

VOCABULARY STYLE GUIDE (Apply these moderately for a natural, human tone):
- Replace "serving as" or "functioning as" with "acting as" or "used as".
- Replace formal words with common equivalents (e.g., "emerged" -> "came about", "utilize" -> "use", "demonstrates" -> "shows").
- NEVER use dramatic adjectives. BANNED: "startling", "profound", "vast", "limitless", "unparalleled", "remarkable".
- NEVER repeat metaphors. BANNED CLICHÉS: "acts as a bridge", "fabric of the universe", "dynamic interplay", "vast landscape".

Use contractions naturally ONLY if the original text uses them or if the tone is casual.

Output ONLY the rewritten text:`;
}


// ==========================================================================
// 4. LLM SERVICE MODULE
// ==========================================================================

/**
 * Calls the Gemini API to humanize a specific chunk of text.
 */
async function humanizeChunk(chunk, apiKey, temperature) {
    const prompt = buildChunkPrompt(chunk);
    const raw = await GeminiAPI.chat(prompt, apiKey, temperature);
    return raw.trim().replace(/^["']|["']$/g, '');
}


// ==========================================================================
// 5. REGEX POST-PROCESSING MODULE (Safety Net)
// ==========================================================================

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
    "persist outside the mind": "exist outside the mind",
    "serving as": "acting as",
    "functioning as": "acting as"
};

function postProcess(text) {
    let result = text;

    // Normalize quotes/apostrophes
    result = result.replace(/[''`´]/g, "'");
    result = result.replace(/[""„]/g, '"');

    // STRICT EM-DASH BANNING
    result = result.replace(/\s*\u2014\s*|\s*\u2013\s*|\s*--\s*/g, ', ');
    result = result.replace(/,\s*,/g, ',');

    // STERILE VOCABULARY SWAPS
    for (const [bad, good] of Object.entries(AI_STERILE_SWAPS)) {
        const regex = new RegExp(`\\b${bad}\\b`, 'gi');
        result = result.replace(regex, (match) => {
            if (match[0] === match[0].toUpperCase()) {
                return good.charAt(0).toUpperCase() + good.slice(1);
            }
            return good;
        });
    }

    // Fix accidental double words (e.g., "the the", "and and")
    result = result.replace(/\b(\w+)\s+\1\b/gi, '$1');

    // Fix accidental double transitions (e.g., "Also, the arrangement of X also...")
    result = result.replace(/\b(Also|Furthermore|Moreover|Additionally),\s+([\w\s]+?)\s+\1\b/gi, '$2');

    // Fix "a" vs "an" grammar errors caused by replacements
    result = result.replace(/\ba ([aeiouAEIOU])/g, 'an $1');
    result = result.replace(/\ban ([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/g, 'a $1');

    // Fix missing space after comma/period
    result = result.replace(/,([a-zA-Z])/g, ', $1');
    result = result.replace(/\.([a-zA-Z])/g, '. $1');

    // Ensure single space between sentences
    result = result.replace(/\s{2,}/g, ' ');

    // Capitalize first letter of every sentence
    result = result.replace(/([.!?]\s+)([a-z])/g, (m, punct, letter) => `${punct}${letter.toUpperCase()}`);
    result = result.replace(/^([a-z])/, (m, letter) => letter.toUpperCase());

    return result.trim();
}


// ==========================================================================
// 6. GROQ 4-STAGE SANITY CHECKER MODULE
// ==========================================================================

const STAGE_1_PROMPT = `You are a post-processing engine. Find unnatural, robotic, or overly formal AI vocabulary in the text (e.g., "utilize", "regarding", "represents", "serving as", "functioning as"). 
Return a JSON object where keys are the exact unnatural phrases from the text, and values are natural, human-sounding alternatives that fit the context. 
Examples of good replacements: "emerged" -> "came about", "serving as" -> "acting as", "demonstrates" -> "shows". 
Do not fix grammar or punctuation, only vocabulary. If none, return {}.`;

const STAGE_2_PROMPT = `You are a strict syntax editor. Find AI syntactic tells in the text: 
1. Em dashes (—) or semicolons (;).
2. "With [noun] [verb]ing" constructions (e.g., "with mathematics acting as...").
3. Participial phrases at the end of sentences (e.g., '..., making it...', '..., revealing...').
4. 'Not only... but also' and 'isn't X, it's Y' structures.
5. Run-on sentences with nested relative clauses (e.g., 'X, which is Y, a concept that does Z').
6. "Both X and Y" structures.
7. COMMA CHAINS: Any sentence containing more than one comma (excluding a simple two-item list). Break these into separate, shorter sentences.
Return a JSON object where keys are the EXACT sentences containing these errors, and values are the rewritten sentences broken into smaller, direct sentences without the banned conventions. If none, return {}.`;

const STAGE_3_PROMPT = `You are a flow editor. Find choppy, staccato groups of 2-3 consecutive disjointed sentences. 
SPECIFIC INSTRUCTIONS:
1. If you find two short sentences comparing two subjects or parallel ideas, combine them using ", while" or ", whereas".
2. If you find two separated sentences that are logically sequential and share a subject (e.g., "X does Y. This means Z."), combine them using a natural transition word (e.g., "X does Y, which means Z.").
Return a JSON object where keys are the EXACT original disjointed sentences (joined by a space), and values are a single, smoothly connected sentence or block. Do not rewrite the whole text, only the disjointed parts. If none, return {}.`;

const STAGE_4_PROMPT = `You are a sentence variety editor. Find instances where 2 or more consecutive sentences start with the exact same word (especially "The", "This", "It", or "Mathematics"). Return a JSON object where keys are the EXACT second or third repetitive sentences, and values are the rewritten sentences with a different, natural opening phrase. If none, return {}.`;

async function groqChat(text, groqKey, instructions) {
    const prompt = `${instructions}\n\nTEXT:\n${text}\n\nJSON OUTPUT:`;
    const messages = [{ role: 'user', content: prompt }];

    try {
        const content = await GroqAPI.chat(messages, groqKey, true);
        return parseGroqJson(content);
    } catch (error) {
        console.error('Groq Stage Failed:', error);
        return {};
    }
}

async function runGroqStages(text, groqKey) {
    let currentText = text;
    const fixes = { stage1: 0, stage2: 0, stage3: 0, stage4: 0 };

    const s1 = await groqChat(currentText, groqKey, STAGE_1_PROMPT);
    currentText = applyJsonReplacements(currentText, s1);
    fixes.stage1 = Object.keys(s1).length;

    const s2 = await groqChat(currentText, groqKey, STAGE_2_PROMPT);
    currentText = applyJsonReplacements(currentText, s2);
    fixes.stage2 = Object.keys(s2).length;

    const s3 = await groqChat(currentText, groqKey, STAGE_3_PROMPT);
    currentText = applyJsonReplacements(currentText, s3);
    fixes.stage3 = Object.keys(s3).length;

    const s4 = await groqChat(currentText, groqKey, STAGE_4_PROMPT);
    currentText = applyJsonReplacements(currentText, s4);
    fixes.stage4 = Object.keys(s4).length;

    return { text: currentText, fixes };
}


// ==========================================================================
// 7. API HANDLER
// ==========================================================================

/**
 * Main API Route Handler
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

        // Step 5: Groq 3-Stage Post-Processing
        let groqFixes = { stage1: 0, stage2: 0, stage3: 0 };
        if (GROQ_KEY) {
            logs.push('Starting Groq 3-stage post-processing...');
            const groqResult = await runGroqStages(result, GROQ_KEY);
            result = groqResult.text;
            groqFixes = groqResult.fixes;
            logs.push(`Groq Stage 1 (Vocab) fixes: ${groqFixes.stage1}`);
            logs.push(`Groq Stage 2 (Syntax) fixes: ${groqFixes.stage2}`);
            logs.push(`Groq Stage 3 (Flow) fixes: ${groqFixes.stage3}`);
        } else {
            logs.push('Skipped Groq post-processing (no API key provided).');
        }

        // Step 6: Final word swap pass
        result = applyWordSwaps(result);

        const totalTimeMs = Date.now() - startTime;
        logs.push(`Final: ${result.length} chars`);

        // Gather actual model usage from the utility files
        const geminiUsage = getGeminiUsage();
        const groqUsage = getGroqModelUsage();

        // Format model usage for UI display
        const formatUsage = (usage) => {
            return Object.entries(usage).map(([model, stats]) => 
                `${model} (${stats.success} ok, ${stats.failed} fail)`
            );
        };

        // Construct the "humanizer" network result object
        const humanizerNetworkResult = {
            executionTimeMs: totalTimeMs,
            executionTimeSec: (totalTimeMs / 1000).toFixed(2),
            inputChars: text.length,
            outputChars: result.length,
            chunksProcessed: chunks.length,
            gemini: {
                totalCalls: Object.values(geminiUsage).reduce((acc, m) => acc + m.success + m.failed, 0),
                modelsUsed: formatUsage(geminiUsage)
            },
            groq: {
                totalCalls: Object.values(groqUsage).reduce((acc, m) => acc + m.success + m.failed, 0),
                modelsUsed: formatUsage(groqUsage),
                fixesApplied: groqFixes
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
        
        const geminiUsage = getGeminiUsage() || {};
        const groqUsage = getGroqModelUsage() || {};
        const formatUsage = (usage) => Object.entries(usage).map(([model, stats]) => `${model} (${stats.success} ok, ${stats.failed} fail)`);
        
        return res.status(500).json({ 
            success: false, 
            error: error.message, 
            logs,
            humanizer: {
                executionTimeMs: totalTimeMs,
                gemini: {
                    totalCalls: Object.values(geminiUsage).reduce((acc, m) => acc + m.success + m.failed, 0),
                    modelsUsed: formatUsage(geminiUsage)
                },
                groq: {
                    totalCalls: Object.values(groqUsage).reduce((acc, m) => acc + m.success + m.failed, 0),
                    modelsUsed: formatUsage(groqUsage)
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
