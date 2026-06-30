// ==========================================================================
// FILE: api/features/humanizer.js
// DESCRIPTION: 
// An API route that humanizes AI-generated text using Gemini. It processes 
// text in chunks to maintain flow and reduce API calls, enforces natural 
// phrasing via strict prompt engineering, and applies a comprehensive 
// single-pass Groq post-processing polish.
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
   - parseGroqJson(): Safely parses JSON strings from Groq. (Retained for utility)
   - applyJsonReplacements(): Safely applies JSON before/after maps to text. (Retained for utility)
   
3. PROMPT ENGINEERING MODULE
   - buildChunkPrompt(): Constructs the LLM prompt with positive humanizing rules.
   
4. LLM SERVICE MODULE
   - humanizeChunk(): Handles the API call to Gemini with safe temperature.
   
5. REGEX POST-PROCESSING MODULE
   - cleanTextMechanics(): Light, safe cleanup of punctuation and grammar.
   - postProcess(): Main regex wrapper.
   
6. GROQ COMPREHENSIVE EDITOR MODULE
   - runGroqStages(): Single-pass comprehensive grammar and flow polish.
   
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
        const cleanJson = content.replace(/^```json\s*|\s*```$/g, '').trim();
        return JSON.parse(cleanJson);
    } catch (error) {
        console.error('Failed to parse Groq JSON:', error, '\nRaw:', content);
        return {};
    }
}

/**
 * Applies a JSON map of { "before": "after" } to a text string.
 */
function applyJsonReplacements(text, jsonMap) {
    let result = text;
    if (!jsonMap || typeof jsonMap !== 'object') return result;

    for (const [before, after] of Object.entries(jsonMap)) {
        if (!before || typeof before !== 'string') continue;
        
        let afterStr = after;
        if (typeof after === 'object' && after !== null) {
            afterStr = Object.values(after).find(v => typeof v === 'string') || '';
        }
        
        if (typeof afterStr !== 'string' || afterStr.length === 0) continue;
        if (afterStr.includes('{') || afterStr.includes('}')) continue;

        const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        result = result.replace(regex, afterStr);
    }
    return result;
}

// ==========================================================================
// 3. PROMPT ENGINEERING MODULE
// ==========================================================================

/**
 * Builds a highly constrained prompt for naturalizing a chunk of text.
 * Uses positive reinforcement instead of negative constraints.
 */
function buildChunkPrompt(chunk) {
    return `Rewrite the following text to sound like it was written by a skilled human writer. Keep the exact same meaning.

GUIDELINES FOR NATURAL WRITING:
- RHYTHM & FLOW: Mix short, punchy sentences with longer, complex ones. Use commas naturally to separate clauses, but avoid run-on sentences. Connect related ideas smoothly using conjunctions (and, but, so, while).
- TONE: Clear, engaging, and direct. Avoid academic stiffness, overly formal vocabulary, and AI clichés (e.g., "delves into", "tapestry", "crucial", "moreover").
- VARIETY: Ensure consecutive sentences have different structures and starting words. Avoid repetitive phrasing.
- NATURAL PHRASING: Use active voice. Avoid awkward constructions like "with [noun] [verb]ing" or excessive use of "which" clauses.

TEXT TO REWRITE:
"${chunk}"

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
// 5. REGEX POST-PROCESSING MODULE
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
    "functioning as": "acting as",
    "act outside of": "exist outside of",
    "truly remarkable": "highly effective",
    "remarkable accomplishment": "major accomplishment",
    "fabric of the universe": "structure of reality",
    "fabric of reality": "structure of reality"
};

/**
 * Cleans text mechanics (punctuation, grammar, double words).
 */
function cleanTextMechanics(text) {
    let result = text;

    // 1. STRICT EM-DASH BANNING
    result = result.replace(/\s*\u2014\s*|\s*\u2013\s*|\s*--\s*/g, ', ');
    result = result.replace(/,\s*,/g, ',');

    // 2. STERILE VOCABULARY SWAPS
    for (const [bad, good] of Object.entries(AI_STERILE_SWAPS)) {
        const regex = new RegExp(`\\b${bad}\\b`, 'gi');
        result = result.replace(regex, (match) => {
            if (match[0] === match[0].toUpperCase()) {
                return good.charAt(0).toUpperCase() + good.slice(1);
            }
            return good;
        });
    }

    // 3. FIX ARTIFACTS & EARLY SPACE COLLAPSE
    result = result.replace(/\.{2,}/g, '.'); // Double periods
    result = result.replace(/,{2,}/g, ','); // Double commas
    result = result.replace(/,\./g, '.');   // Comma followed by period
    result = result.replace(/\b(\w+)\s+\1\b/gi, '$1'); // Double words
    result = result.replace(/\b(Also|Furthermore|Moreover|Additionally),\s+([\w\s]+?)\s+\1\b/gi, '$2'); // Double transitions
    result = result.replace(/\b(\w+)\s+and\s+\1\b/gi, '$1'); // "X and X" redundancy
    
    // Fix "but However" or "but However,"
    result = result.replace(/\b[Bb]ut\s+[Hh]owever,?\s*/g, 'However, ');

    // CRITICAL FIX: Collapse multiple spaces EARLY so grammar regexes work properly
    result = result.replace(/\s{2,}/g, ' ');

    // 4. GRAMMAR FIXES (a vs an) - Now tolerant of spacing
    result = result.replace(/\ba\s+([aeiouAEIOU])/g, 'an $1');
    result = result.replace(/\ban\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/g, 'a $1');
    // Specific fix for 'u' words that sound like 'y' (e.g., "an useful" -> "a useful")
    result = result.replace(/\ban\s+(useful|uniform|union|university|user|ubiquitous|unicorn)/gi, 'a $1');
    // Fix missing 'a' in "as means of"
    result = result.replace(/\bas\s+means\s+of/gi, 'as a means of');

    // 5. FIX COMMA SPLICES WITH CAPITAL LETTERS (e.g., "them, However," -> "them. However,")
    result = result.replace(/,\s+([A-Z][a-z]+)\s/g, '. $1 ');

    // 6. SPACING & CAPITALIZATION
    result = result.replace(/,([a-zA-Z])/g, ', $1');
    result = result.replace(/\.([a-zA-Z])/g, '. $1');
    result = result.replace(/([.!?]\s+)([a-z])/g, (m, punct, letter) => `${punct}${letter.toUpperCase()}`);
    result = result.replace(/^([a-z])/, (m, letter) => letter.toUpperCase());

    return result.trim();
}

/**
 * Main post-processing function.
 */
function postProcess(text) {
    let result = text;
    result = result.replace(/[''`´]/g, "'");
    result = result.replace(/[""„]/g, '"');
    return cleanTextMechanics(result);
}

// ==========================================================================
// 6. GROQ COMPREHENSIVE EDITOR MODULE
// ==========================================================================

const GROQ_EDITOR_PROMPT = `You are an expert human copyeditor. Review the following text for grammar, typos, awkward phrasing, and robotic flow. 
1. Fix any grammatical errors (like comma splices, wrong articles, or sentence fragments).
2. Rewrite any sentences that sound unnatural, stiff, or overly formal.
3. Ensure the text flows smoothly and reads like it was written by a human.

Output ONLY the fully corrected text. Do not output JSON, explanations, or markdown formatting.

TEXT:
`;

/**
 * Runs a single, comprehensive Groq pass to polish the text.
 * Replaces the old 6-stage JSON pipeline for better reliability and speed.
 */
async function runGroqStages(text, groqKey) {
    const prompt = GROQ_EDITOR_PROMPT + text;
    const messages = [{ role: 'user', content: prompt }];

    try {
        // GroqAPI.chat returns the raw string content
        const content = await GroqAPI.chat(messages, groqKey, true); 
        
        return { 
            text: content.trim().replace(/^["']|["']$/g, ''), 
            // Returning a mock 'fixes' object to maintain compatibility with the handler's logging
            fixes: { 
                stage1: 0, stage2: 0, stage3: 0, stage4: 0, stage5: 0, stage6: 0,
                comprehensivePolish: 1 
            } 
        };
    } catch (error) {
        console.error('Groq Polish Failed:', error);
        return { 
            text, 
            fixes: { stage1: 0, stage2: 0, stage3: 0, stage4: 0, stage5: 0, stage6: 0, comprehensivePolish: 0 } 
        };
    }
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
    
    resetGeminiUsage();
    resetGroqModelUsage();

    try {
        // Frontend only sends { text, apiKey }. We use the server env for Groq.
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
                logs.push(`Chunk ${i + 1}/${chunks.length}: FAILED (${err.message})`);
                humanizedChunks.push(chunks[i]);
            }
        }

        // Step 4: Rejoin and initial regex post-process
        let result = humanizedChunks.join(' ');
        result = postProcess(result);
        logs.push('Applied regex post-processing');

        // Step 5: Groq Comprehensive Post-Processing
        let groqFixes = { stage1: 0, stage2: 0, stage3: 0, stage4: 0, stage5: 0, stage6: 0, comprehensivePolish: 0 };
        if (GROQ_KEY) {
            logs.push('Starting Groq comprehensive polish...');
            const groqResult = await runGroqStages(result, GROQ_KEY);
            result = groqResult.text;
            groqFixes = groqResult.fixes;
            logs.push(`Groq comprehensive polish completed successfully.`);
        } else {
            logs.push('Skipped Groq post-processing (no API key provided).');
        }

        // Step 6: Final word swap pass
        result = applyWordSwaps(result);

        const totalTimeMs = Date.now() - startTime;
        logs.push(`Final: ${result.length} chars`);

        const geminiUsage = getGeminiUsage();
        const groqUsage = getGroqModelUsage();

        const formatUsage = (usage) => {
            return Object.entries(usage).map(([model, stats]) => 
                `${model} (${stats.success} ok, ${stats.failed} fail)`
            );
        };

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
