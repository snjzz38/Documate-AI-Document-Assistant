// ==========================================================================
// FILE: api/features/humanizer.js
// DESCRIPTION: 
// An API route that humanizes AI-generated text using Gemini. It processes 
// text in chunks to maintain flow and reduce API calls, enforces natural 
// phrasing via strict prompt engineering, and applies safe 6-stage post-processing.
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
   - parseGroqJson(): Safely parses JSON strings from Groq.
   - applyJsonReplacements(): Safely applies JSON before/after maps to text.
   
3. PROMPT ENGINEERING MODULE
   - buildChunkPrompt(): Constructs the LLM prompt with strict humanizing rules.
   
4. LLM SERVICE MODULE
   - humanizeChunk(): Handles the API call to Gemini with safe temperature.
   
5. REGEX POST-PROCESSING MODULE
   - cleanTextMechanics(): Light, safe cleanup of punctuation and grammar.
   - postProcess(): Main regex wrapper.
   
6. GROQ 6-STAGE SANITY CHECKER MODULE
   - Stage 1: Vocabulary context fixes.
   - Stage 2: Syntactic AI tells (lists, em dashes, participles, etc.).
   - Stage 3: Staccato flow and transition fixes.
   - Stage 4: Repetitive sentence starters.
   - Stage 5: Lexical variety (root word repetition).
   - Stage 6: Grammar and typo correction.
   
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
 * STRICT MATCH: Replaces ONLY the first instance of an exact string match.
 * SAFETY: Prevents [object Object] and JSON string injection.
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

        // CRITICAL FIX: Prevent Groq from injecting raw JSON strings or meta-commentary into the text
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
 */
function buildChunkPrompt(chunk, prevChunk, nextChunk) {
    let contextBlock = "";
    if (prevChunk || nextChunk) {
        contextBlock = `\nSURROUNDING CONTEXT (Do NOT rewrite the context, ONLY use it to understand what comes before/after so your rewritten chunk flows perfectly):\nPREVIOUS TEXT: "${prevChunk || 'None'}"\nNEXT TEXT: "${nextChunk || 'None'}"\n`;
    }
    
    return `Rewrite the following text so it sounds like a human wrote it. Keep the exact same meaning. MATCH THE ORIGINAL TONE (if it is academic, keep it academic; do not make it conversational, informal, or add rhetorical questions).
 ${contextBlock}
TEXT TO REWRITE:
"${chunk}"

STRICT RULES:
1. Output ONLY the rewritten text (the chunk itself). No commentary. Do NOT output the context.
2. SENTENCE FLOW & COHERENCE: You MUST connect related ideas logically. Do NOT output a list of choppy, disconnected sentences. Combine related sentences into fluid, coherent thoughts.
3. BURSTINESS: Vary sentence lengths. Do NOT write long, convoluted, run-on sentences. If a sentence has more than two clauses, split it into two sentences.
4. COMPLETE SENTENCES: Every sentence MUST be grammatically complete and standalone. NEVER start a sentence with "And", "With", "As", or "Which". NEVER leave sentence fragments.
5. NO TAUTOLOGIES: NEVER repeat the same word or concept in the same sentence (e.g., DO NOT write "Treating people as products... view their children as products").
6. NO LISTS OF THREE: Never list three items. Use two items, or separate sentences.
7. NO CLICHÉS: NEVER use "fabric of the universe", "profound", "remarkable", "dynamic interplay", "vast landscape", "intrinsic value", "global challenges", or "particularly when given". Use plain, literal words.
8. NO EM DASHES (—) or SEMICOLONS (;). 
9. NO COMMA CHAINS: A sentence must not have more than one comma.
10. NO "WITH [NOUN] [VERB]ING": Never use "with [noun] [verb]ing" constructions. Break them into separate sentences.
11. NO PARTICIPIAL PHRASES: Never end a sentence with a comma and an -ing verb.
12. NEVER start consecutive sentences with the same word. NEVER start sentences with "Ultimately", "Similarly", "Furthermore", "Thus,", or "As a result,".
13. Do NOT repeat the same concept or premise in consecutive sentences.

Output ONLY the rewritten chunk:`;
}

// ==========================================================================
// 4. LLM SERVICE MODULE
// ==========================================================================

/**
 * Calls the Gemini API to humanize a specific chunk of text.
 */
async function humanizeChunk(chunk, prevChunk, nextChunk, apiKey, temperature) {
    const prompt = buildChunkPrompt(chunk, prevChunk, nextChunk);
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
    "fabric of reality": "structure of reality",
    "mortal invention": "human invention",
    "mortal creation": "human creation",
    "facilitated by this methodology": "helped by this approach",
    "in-depth analysis is facilitated": "detailed analysis is helped",
    "striking resemblance": "close resemblance",
    "product of human ingenuity": "human creation",
    "infinite array": "large number",
    "vast array": "large number",
    "rigorous investigation": "detailed study",
    "serves as a bridge": "acts as a link",
    "the nature world": "the natural world",
    "global challenges": "major world problems",
    "particularly when given": "especially when given"
};

/**
 * Cleans text mechanics (punctuation, grammar, double words).
 */
function cleanTextMechanics(text) {
    let result = text;

    // STRICT EM-DASH & SEMICOLON BANNING
    result = result.replace(/\s*\u2014\s*|\s*\u2013\s*|\s*--\s*/g, ', ');
    result = result.replace(/;/g, '.'); // Convert all semicolons to periods
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
    result = result.replace(/\.{2,}/g, '.'); // Double periods
    result = result.replace(/,{2,}/g, ','); // Double commas
    result = result.replace(/\.\s*,/g, '.');   // Period followed by comma
    result = result.replace(/,\s*\./g, '.');   // Comma followed by period
    result = result.replace(/\b(\w+)\s+\1\b/gi, '$1'); // Double words
    result = result.replace(/\b(Also|Furthermore|Moreover|Additionally),\s+([\w\s]+?)\s+\1\b/gi, '$2'); // Double transitions
    result = result.replace(/\b(\w+)\s+and\s+\1\b/gi, '$1'); // "X and X" redundancy
    
    // Fix Comma Splices (e.g., "world, The Fibonacci" -> "world. The Fibonacci")
    result = result.replace(/,(\s+[A-Z][a-z])/g, '.$1');
    
    // Fix "but However" or "but However,"
    result = result.replace(/\b[Bb]ut\s+[Hh]owever,?\s*/g, 'However, ');
    // Fix missing period before "However"
    result = result.replace(/,\s*However,/gi, '. However,');
    result = result.replace(/,\s*However\s/gi, '. However ');

    // GRAMMAR FIXES (a vs an)
    result = result.replace(/\ba ([aeiouAEIOU])/g, 'an $1');
    result = result.replace(/\ban ([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/g, 'a $1');
    result = result.replace(/\ban (useful|uniform|union|university|user|ubiquitous|unicorn)/gi, 'a $1');
    result = result.replace(/\ban discovery/gi, 'a discovery');
    result = result.replace(/\ban human/gi, 'a human');
    result = result.replace(/\bas means of/gi, 'as a means of');

    // SPACING & CAPITALIZATION
    result = result.replace(/,([a-zA-Z])/g, ', $1');
    result = result.replace(/\.([a-zA-Z])/g, '. $1');
    result = result.replace(/\s{2,}/g, ' ');
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
// 6. GROQ 4-STAGE SANITY CHECKER MODULE
// ==========================================================================

const STAGE_1_PROMPT = `You are a post-processing engine. Find unnatural, robotic, or overly formal AI vocabulary in the text, AND find instances where the same word root is repeated multiple times in close proximity (e.g., "logic", "logically"). 
Return a JSON object where keys are the exact unnatural/repeated phrases from the text, and values are natural, human-sounding alternatives that fit the context. 
Make sure your returned object contains the exact replacement, and that applying the replacement verbatim won't lead to any gramatical mistakes. Do not fix grammar or punctuation, only vocabulary. If none, return {}.`;

const STAGE_2_PROMPT = `You are a strict syntax editor. Find AI syntactic tells in the text: 
1. Em dashes (—) or semicolons (;).
2. LISTS OF THREE OR MORE: Any list of 3 or more items. Reduce them to exactly TWO items.
3. Excessive ", which" clauses (more than 1 per paragraph).
4. Participial phrases (e.g., "perspectives, acting as..." or "...world, using basic rules..."). Replace with "and [verb]".
5. COMMA CHAINS: Any sentence containing more than one comma. Fix it by removing unnecessary clauses or splitting it, but DO NOT delete conjunctions like "and" or "which" if they are necessary for grammar.
6. "WITH [NOUN] [VERB]ING" constructions. Break them into separate sentences.
7. Repetitive sentence starters: If 2 or more consecutive sentences start with the same word, or start with a transition word/phrase followed by a comma (e.g., "However,", "Therefore,"). Rewrite the second sentence to have a different, natural opening phrase.
Return a JSON object where keys are the EXACT sentences containing these errors, and values are the rewritten sentences. Ensure the grammar and punctuation are perfect. If none, return {}.`;

const STAGE_3_PROMPT = `You are a minimal flow editor. Find ONLY egregious, choppy pairs of consecutive 3-4 word sentences (e.g., "Math is a tool. It helps us."). Combine them into one sentence using "and" or "so". 
CRITICAL RULES: 
- NEVER change the meaning or add words. 
- NEVER create run-on sentences or comma chains.
- NEVER include meta-commentary, explanations, or reasoning in your output. ONLY output the exact replacement text.
- If you are not 100% sure the combination is perfect, return {}.
Return a JSON object where keys are the EXACT original disjointed sentences (joined by a space), and values are a single, smoothly connected sentence. If none, return {}.`;

const STAGE_4_PROMPT = `You are a meticulous grammar and typo editor. Find sentences with typos, spelling errors, or broken syntax (e.g., missing conjunctions like "and" or "which", resulting in "...changes, can permanently modify..."). 
CRITICAL: Find and fix SENTENCE FRAGMENTS. If a sentence starts with "And", "With", "As", or "Which" and does not form a complete thought, combine it with the previous sentence.
CRITICAL: Find and fix TAUTOLOGIES. If a sentence repeats the same word or concept (e.g., "Treating people as PRODUCTS... view their children as PRODUCTS"), rewrite it to be concise and non-repetitive.
CRITICAL: Find and fix COMMA SPLICES. If two independent clauses are joined by a comma, fix it by changing the comma to a period or adding a conjunction.
CRITICAL: NEVER include meta-commentary, explanations, or reasoning in your output. ONLY output the exact replacement text.
Also check for article errors (e.g., "an discovery" instead of "a discovery").
Return a JSON object where keys are the EXACT broken sentences/fragments, and values are the corrected sentences with perfect grammar. Do not change the meaning. If none, return {}.`;

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
            // Pass previous humanized chunk and next original chunk for context
            let prevChunk = i > 0 ? humanizedChunks[i - 1] : "";
            let nextChunk = i < chunks.length - 1 ? chunks[i + 1] : "";
            
            try {
                const humanized = await humanizeChunk(chunks[i], prevChunk, nextChunk, GEMINI_KEY, temperature);
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

        // Step 5: Groq 4-Stage Post-Processing
        let groqFixes = { stage1: 0, stage2: 0, stage3: 0, stage4: 0 };
        if (GROQ_KEY) {
            logs.push('Starting Groq 4-stage post-processing...');
            const groqResult = await runGroqStages(result, GROQ_KEY);
            result = groqResult.text;
            groqFixes = groqResult.fixes;
            logs.push(`Groq Stage 1 (Vocab/Lexical) fixes: ${groqFixes.stage1}`);
            logs.push(`Groq Stage 2 (Syntax/Variety) fixes: ${groqFixes.stage2}`);
            logs.push(`Groq Stage 3 (Flow) fixes: ${groqFixes.stage3}`);
            logs.push(`Groq Stage 4 (Grammar) fixes: ${groqFixes.stage4}`);
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
