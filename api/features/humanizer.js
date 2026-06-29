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

function splitIntoChunks(text, sentencesPerChunk = 4) {
    const sentenceRegex = /[^.!?]+[.!?]+(?=\s|$|\n)/g;
    const sentences = text.match(sentenceRegex) || [text];
    const chunks = [];
    for (let i = 0; i < sentences.length; i += sentencesPerChunk) {
        chunks.push(sentences.slice(i, i + sentencesPerChunk).join(' ').trim());
    }
    return chunks.filter(c => c.length > 0);
}

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
 * STRICT MATCH: Replaces ONLY the first instance of an exact string match.
 */
function applyJsonReplacements(text, jsonMap) {
    let result = text;
    if (!jsonMap || typeof jsonMap !== 'object') return result;

    for (const [before, after] of Object.entries(jsonMap)) {
        if (!before) continue;
        
        let afterStr = after;
        if (typeof after === 'object' && after !== null) {
            afterStr = Object.values(after).find(v => typeof v === 'string') || '';
        }
        if (typeof afterStr !== 'string' || afterStr.length === 0) continue;

        // Escape regex characters for exact match
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
 */
function buildChunkPrompt(chunk) {
    return `Rewrite the following text so it sounds like a human wrote it. Keep the exact same meaning. MATCH THE ORIGINAL TONE (if it is academic, keep it academic; do not make it conversational, informal, or add rhetorical questions).

TEXT TO REWRITE:
"${chunk}"

STRICT RULES:
1. Output ONLY the rewritten text. No commentary, no quotes around the output.
2. FOCUS ON CLARITY: Write clearly and naturally. Do NOT output broken grammar or clunky syntax.
3. NO LISTS OF THREE: Never list three items (A, B, and C). Use two items, or separate sentences.
4. NO EM DASHES (—) or SEMICOLONS (;). Use periods or commas instead.
5. NO COMMA CHAINS: A sentence must not have more than one comma.
6. NO "WITH [NOUN] [VERB]ING": Never use "with [noun] [verb]ing" constructions (e.g., "with mathematics acting as..."). Break them into separate sentences.
7. NO PARTICIPIAL PHRASES: Never end a sentence with a comma and an -ing verb (e.g., "..., making it important").
8. NO CLICHÉS: Never use "fabric of the universe", "dynamic interplay", or "vast landscape".
9. NEVER start consecutive sentences with the same word.

Use contractions naturally ONLY if the original text uses them or if the tone is casual.

Output ONLY the rewritten chunk:`;
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
    "environmental world": "natural world",
    "mortal invention": "human invention",
    "endless terrain": "many areas"
};

function cleanTextMechanics(text) {
    let result = text;

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

    // FIX GROQ REPLACEMENT ARTIFACTS
    result = result.replace(/\.{2,}/g, '.');
    result = result.replace(/,{2,}/g, ',');
    result = result.replace(/\b(\w+)\s+\1\b/gi, '$1');
    result = result.replace(/\b(Also|Furthermore|Moreover|Additionally),\s+([\w\s]+?)\s+\1\b/gi, '$2');

    // GRAMMAR FIXES
    result = result.replace(/\ba ([aeiouAEIOU])/g, 'an $1');
    result = result.replace(/\ban ([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/g, 'a $1');
    
    // Fix "a [plural noun]" -> remove the "a" (basic heuristic for Groq errors like "a mental calculations")
    result = result.replace(/\ba ([a-zA-Z]+s)(\s|,|\.)/g, '$1$2');

    // SPACING & CAPITALIZATION
    result = result.replace(/,([a-zA-Z])/g, ', $1');
    result = result.replace(/\.([a-zA-Z])/g, '. $1');
    result = result.replace(/\s{2,}/g, ' ');
    result = result.replace(/([.!?]\s+)([a-z])/g, (m, punct, letter) => `${punct}${letter.toUpperCase()}`);
    result = result.replace(/^([a-z])/, (m, letter) => letter.toUpperCase());

    return result.trim();
}

function postProcess(text) {
    let result = text;
    result = result.replace(/[''`´]/g, "'");
    result = result.replace(/[""„]/g, '"');
    return cleanTextMechanics(result);
}

// ==========================================================================
// 6. GROQ 5-STAGE SANITY CHECKER MODULE
// ==========================================================================

const STAGE_1_PROMPT = `You are a post-processing engine. Find unnatural, robotic, or overly formal AI vocabulary in the text. 
Return a JSON object where keys are the exact unnatural phrases from the text, and values are natural, human-sounding alternatives. 
CRITICAL GRAMMAR RULE: Ensure your replacement matches the exact grammatical context (articles, plurality, tense) so applying it verbatim won't lead to grammar mistakes. Do not fix punctuation. If none, return {}.`;

const STAGE_2_PROMPT = `You are a strict syntax editor. Find AI syntactic tells in the text: 
1. Em dashes (—) or semicolons (;).
2. Excessive ", which" clauses (more than 1 per paragraph).
3. Participial phrases (e.g., "perspectives, acting as..."). Replace with "and [verb]".
4. "With [noun] [verb]ing" constructions. Break them into separate sentences.
5. COMMA CHAINS: Any sentence containing more than one comma. Break these into separate, shorter sentences using periods.
6. CLICHÉS: "woven into the fabric", "endless terrain", "vast landscape". Replace with literal descriptions.
Return a JSON object where keys are the EXACT sentences containing these errors, and values are the rewritten sentences WITHOUT using any of the banned conventions. Ensure the grammar and punctuation are perfect. If none, return {}.`;

const STAGE_3_PROMPT = `You are a flow editor. Find choppy, staccato pairs of consecutive disjointed sentences. 
SPECIFIC INSTRUCTIONS:
1. If you find two short sentences comparing two subjects, combine them using ", while" or ", whereas".
2. If you find two separated sentences that are logically sequential or share a subject, combine them using a comma and a conjunction.
CRITICAL RULES: 
- NEVER use ", which" to combine sentences.
- NEVER create run-on sentences or dangling clauses.
- Ensure the resulting grammar and punctuation are perfect.
Return a JSON object where keys are the EXACT original disjointed sentences (joined by a space), and values are a single, smoothly connected sentence. If none, return {}.`;

const STAGE_4_PROMPT = `You are a sentence variety editor. Find instances where:
1. 2 or more consecutive sentences start with the exact same word.
2. Sentences start with a transition word/phrase followed by a comma (e.g., "However,", "Therefore,", "In contrast,").
Return a JSON object where keys are the EXACT repetitive or transition-starting sentences, and values are the rewritten sentences with a different, natural opening phrase. Ensure the grammar and punctuation are perfect. If none, return {}.`;

const STAGE_5_PROMPT = `You are a lexical variety editor. Find instances where the same word root is repeated multiple times in close proximity (e.g., "logic", "logically", "logical"). 
Return a JSON object where keys are the exact repeated words/phrases, and values are appropriate synonyms that fit the context. 
CRITICAL GRAMMAR RULE: Ensure your replacement matches the exact grammatical context so applying it verbatim won't lead to grammar mistakes. If none, return {}.`;

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
    const fixes = { stage1: 0, stage2: 0, stage3: 0, stage4: 0, stage5: 0 };

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

    const s5 = await groqChat(currentText, groqKey, STAGE_5_PROMPT);
    currentText = applyJsonReplacements(currentText, s5);
    fixes.stage5 = Object.keys(s5).length;

    currentText = cleanTextMechanics(currentText);

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
                // Pass the original text alongside the chunk
                const humanized = await humanizeChunk(chunks[i], text, GEMINI_KEY, temperature);
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
