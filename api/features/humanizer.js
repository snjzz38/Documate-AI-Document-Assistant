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
   - splitIntoChunks(): Safely splits text into sentence groups (Fallback).
   - groqLogicalChunk(): Uses Groq to group sentences into logical paragraphs.
   - applyWordSwaps(): Case-preserving replacement of banned words.
   - parseGroqJson(): Safely parses JSON strings from Groq.
   - applyJsonReplacements(): Safely applies JSON before/after maps to text.
   - injectBurstiness(): Mechanically splits long sentences to increase burstiness.
   
3. PROMPT ENGINEERING MODULE
   - buildChunkPrompt(): Constructs the LLM prompt mimicking human exemplar essays.
   
4. LLM SERVICE MODULE
   - humanizeChunk(): Handles the API call to Gemini with safe temperature.
   
5. REGEX POST-PROCESSING MODULE
   - cleanTextMechanics(): Light, safe cleanup of punctuation and grammar.
   - postProcess(): Main regex wrapper.
   
6. GROQ SINGLE-STAGE JSON FIXER MODULE
   - runGroqStages(): Analyzes full text and fixes fragments, comma chains, and flow.
   
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
    // Removed "fundamental": "basic" to stop "basically" from sounding clunky
};


// ==========================================================================
// 2. TEXT UTILITIES MODULE
// ==========================================================================

/**
 * Splits text into chunks of sentences without breaking on common abbreviations.
 * (Fallback if Groq is unavailable)
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
 * Uses Groq to group sentences into logical, topically coherent paragraphs.
 */
async function groqLogicalChunk(text, groqKey) {
    const prompt = `You are an expert editor. Analyze the following text and group the sentences into 2-4 logical paragraphs based on their topics. Do NOT change the wording of the sentences at all. Only group them. Return a JSON object with a key "chunks" containing an array of strings, where each string is a logical paragraph.

TEXT TO ANALYZE:
 ${text}

JSON OUTPUT:`;

    const messages = [{ role: 'user', content: prompt }];
    try {
        const content = await GroqAPI.chat(messages, groqKey, true);
        const parsed = parseGroqJson(content);
        if (parsed.chunks && Array.isArray(parsed.chunks) && parsed.chunks.length > 0) {
            return parsed.chunks;
        }
        return splitIntoChunks(text); // Fallback
    } catch (error) {
        console.error('Groq Logical Chunking Failed:', error);
        return splitIntoChunks(text); // Fallback
    }
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

/**
 * Mechanically splits long sentences to increase burstiness.
 */
function injectBurstiness(text) {
    let sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    let result = [];

    for (let i = 0; i < sentences.length; i++) {
        let s = sentences[i].trim();
        let words = s.split(' ');

        // Lowered threshold to 16 words, 50% chance to split
        if (words.length > 16 && Math.random() > 0.5) {
            let splitIdx = words.findIndex((w, idx) => idx > 6 && (w.toLowerCase() === 'and' || w.toLowerCase() === 'but' || w.toLowerCase() === 'so' || w.toLowerCase() === 'while'));
            
            if (splitIdx !== -1) {
                let part1 = words.slice(0, splitIdx).join(' ').trim();
                let part2 = words.slice(splitIdx).join(' ').trim();
                
                if (!part1.endsWith('.') && !part1.endsWith(',') && !part1.endsWith(';')) part1 += '.';
                part2 = part2.charAt(0).toUpperCase() + part2.slice(1);
                
                result.push(part1);
                result.push(part2);
                continue;
            }
        }
        result.push(s);
    }
    return result.join(' ');
}

/**
 * Mechanically breaks AI comma chains and ", and" loops to increase burstiness.
 */
function mechanicalCommaBreaker(text) {
    let result = text;
    // Break ", and [Capital Letter]" into two sentences
    result = result.replace(/,\s+and\s+([A-Z][a-z])/g, '. $1');
    // Break ", but [Capital Letter]" into two sentences
    result = result.replace(/,\s+but\s+([A-Z][a-z])/g, '. But $1');
    // Break ", which" into ". This" to destroy relative clauses
    result = result.replace(/,\s+which\s/gi, '. This ');
    return result;
}

// ==========================================================================
// 3. PROMPT ENGINEERING MODULE
// ==========================================================================

// A condensed snippet of the Turnitin-verified human exemplar to force mimicry.
const EXEMPLAR_SNIPPET = `In Angela's Ashes, McCourt develops the characters by immediately separating children from adults. The narrator's father is gone, northward, leaving the family far behind, while the grandparents are hostile. Even the mother seems antagonistic and unfriendly, whining for her children's help, instead of doing things for herself. This host of unfriendly, enemy-like adults helps to establish a mood of everything being stacked against the children. In The Street, a very different spectacle is set. To establish an unkind environment, the author uses not unfriendly characters, but the absence of side characters at all. Petry instead personifies the November wind and compares it to the struggles of life. The author uses the wind to show how difficult it is to live in a world that seems to be throwing things your way. She states, "It did everything it could to discourage the people walking along the street." Lutie Johnson, the main character of the story, was forced to push through this harsh November wind in order to find a place to stay. Like Frank McCourt, Lutie Johnson struggled with poverty too, but she couldn't let it stop her from getting where she needed to go.`;

/**
 * Builds a prompt that forces the AI to mimic the human exemplar style.
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
1. Output ONLY the rewritten text. No commentary.
2. CONTRACTIONS (CRITICAL): You MUST use natural English contractions (doesn't, isn't, can't, won't, it's, they're) where they fit naturally. Do not write in sterile, contraction-free prose.
3. BURSTINESS: You MUST vary sentence lengths drastically. At least 25% of your sentences MUST be very short (under 8 words).
4. NO PARTICIPIAL PHRASES: NEVER end a sentence with a comma and an -ing verb (e.g., DO NOT write "...eliminating the need"). Use "and [verb]" or split it into a new sentence.
5. NO AI PIVOTS: NEVER use "Beyond [X], Y will transform..." or "Adopting this method alters...". Use natural transitions.
6. FLOW & TRANSITIONS: Use natural narrative transitions (e.g., "Unlike X, Y...", "To achieve this..."). NEVER start sentences with "Furthermore,", "Moreover,", "Additionally,", "So,", or "Also,".
7. COMPLETE SENTENCES: Every sentence MUST be grammatically complete and standalone. NEVER leave sentence fragments.
8. NO TAUTOLOGIES: NEVER repeat the same word or concept in consecutive sentences.
9. NO CLICHÉS: NEVER use "fabric of the universe", "profound", "remarkable", or "dynamic interplay". 
10. NO EM DASHES (—) or SEMICOLONS (;). 
11. NO COMMA CHAINS: A sentence must not have more than one comma.

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
    // Removed "serving as" and "functioning as" as they are fine in academic text
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
    result = cleanTextMechanics(result);
    
    // Mechanically break comma chains AFTER initial cleaning
    result = mechanicalCommaBreaker(result);
    
    // Run cleaner one more time to fix spacing/capitalization from the breaks
    result = cleanTextMechanics(result);
    
    return result;
}

// ==========================================================================
// 6. GROQ SENTENCE RESTRUCTURER MODULE
// ==========================================================================

const RESTRUCTURE_PROMPT = `You are an expert syntax editor. Rewrite the syntax of the provided sentences to make them highly complex and human-like. 
RULES:
1. Use dependent clauses (e.g., "Because of X, Y...", "Although X, Y...", "While X, Y...").
2. Keep the EXACT same meaning. Do not add new facts.
3. Do NOT use em dashes (—) or semicolons (;).
4. Do NOT use ", and" or ", but" to connect independent clauses.
5. Return a JSON object with a key "rewrites" containing an array of objects, each with "original" (the exact input sentence) and "rewritten" (the new sentence).`;

async function restructureSentences(text, groqKey) {
    const sentenceRegex = /[^.!?]+[.!?]+/g;
    let sentences = text.match(sentenceRegex) || [];
    if (sentences.length < 4) return { text: text, fixes: 0 };

    // Randomly pick ~30% of the sentences to restructure
    const numToPick = Math.max(1, Math.floor(sentences.length * 0.3));
    const picked = [...sentences].sort(() => 0.5 - Math.random()).slice(0, numToPick);
    
    if (picked.length === 0) return { text: text, fixes: 0 };

    const prompt = `${RESTRUCTURE_PROMPT}\n\nSENTENCES TO REWRITE:\n${JSON.stringify(picked)}\n\nJSON OUTPUT:`;
    const messages = [{ role: 'user', content: prompt }];

    try {
        const content = await GroqAPI.chat(messages, groqKey, true);
        const parsed = parseGroqJson(content);
        
        if (parsed.rewrites && Array.isArray(parsed.rewrites)) {
            const rewriteMap = {};
            parsed.rewrites.forEach(r => {
                if (r.original && r.rewritten) rewriteMap[r.original] = r.rewritten;
            });
            const newText = applyJsonReplacements(text, rewriteMap);
            return { text: newText, fixes: parsed.rewrites.length };
        }
    } catch (error) {
        console.error('Groq Sentence Restructure Failed:', error);
    }
    return { text: text, fixes: 0 };
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
        const { text, apiKey, groqApiKey } = req.body;
        const GEMINI_KEY = apiKey || process.env.GEMINI_API_KEY;
        const GROQ_KEY = groqApiKey || process.env.GROQ_API_KEY;

        if (!text) throw new Error("No text provided.");
        if (!GEMINI_KEY) throw new Error("No Gemini API key provided.");

        logs.push(`Input: ${text.length} chars`);

        // Step 1: Initial word swaps on the full input
        let processed = applyWordSwaps(text);
        logs.push('Applied banned word replacements');

        // Step 2: Split into logical chunks using Groq (or fallback to regex)
        let chunks = [];
        if (GROQ_KEY) {
            logs.push('Analyzing logical chunks with Groq...');
            chunks = await groqLogicalChunk(processed, GROQ_KEY);
        } else {
            chunks = splitIntoChunks(processed, 4);
        }
        logs.push(`Split into ${chunks.length} logical chunks`);

        const temperature = 0.7 + Math.random() * 0.3;
        logs.push(`Temperature: ${temperature.toFixed(2)}`);

        // Step 3: Humanize chunks sequentially
        const humanizedChunks = [];
        for (let i = 0; i < chunks.length; i++) {
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
        logs.push('Applied regex post-processing & mechanical burstiness');

        // Step 5: Groq Targeted Sentence Restructuring
        let groqFixes = { restructures: 0 };
        if (GROQ_KEY) {
            logs.push('Starting Groq targeted sentence restructuring...');
            const groqResult = await restructureSentences(result, GROQ_KEY);
            result = groqResult.text;
            groqFixes.restructures = groqResult.fixes;
            logs.push(`Groq restructured ${groqFixes.restructures} sentences for perplexity.`);
            
            // Run regex one last time to clean up any artifacts
            result = cleanTextMechanics(result);
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
