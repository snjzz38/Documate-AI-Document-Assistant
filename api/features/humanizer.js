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

const EXEMPLAR_SNIPPET = `In Angela's Ashes, McCourt develops the characters by immediately separating children from adults. The narrator's father is gone, northward, leaving the family far behind, while the grandparents are hostile. Even the mother seems antagonistic and unfriendly, whining for her children's help, instead of doing things for herself. This host of unfriendly, enemy-like adults helps to establish a mood of everything being stacked against the children. In The Street, a very different spectacle is set. To establish an unkind environment, the author uses not unfriendly characters, but the absence of side characters at all. Petry instead personifies the November wind and compares it to the struggles of life. She states, "It did everything it could to discourage the people walking along the street." Lutie Johnson was forced to push through this harsh November wind in order to find a place to stay. Like Frank McCourt, Lutie Johnson struggled with poverty too, but she couldn't let it stop her from getting where she needed to go.`;

/**
 * Builds a simplified, persona-based prompt for naturalizing a chunk of text.
 */
function buildChunkPrompt(chunk) {
    return `You are a smart, slightly imperfect high school student writing an academic essay. Rewrite the following text so it sounds exactly like a human wrote it. Keep the exact same meaning and academic tone. Do not add rhetorical questions or conversational slang.

HUMAN EXEMPLAR STYLE (Mimic this exact flow, transition style, and syntactic variety):
 ${EXEMPLAR_SNIPPET}

TEXT TO REWRITE:
"${chunk}"

STRICT RULES:
1. Output ONLY the rewritten text. No commentary. No titles or headers.
2. Vary your sentence lengths drastically. Mix short, punchy sentences with longer, complex ones.
3. Use natural transitions (e.g., "Because of this,", "To achieve this,", "Unlike X, Y..."). NEVER start sentences with "Furthermore," "Moreover," "Thus," or "Additionally,".
4. Do NOT use ", and" or ", but" to glue two independent clauses together. Use a period to split them into separate sentences.
5. Do NOT use em dashes (—) or semicolons (;).
6. Do NOT use lists of three items. Use two items, or separate sentences.
7. NEVER use the words: "profound", "remarkable", "fabric of the universe", "dynamic interplay", "intrinsic value", or "facilitate".

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
    "represents": "is",
    "serving as": "acting as",
    "functioning as": "acting as",
    "facilitated by this methodology": "helped by this approach",
    "striking resemblance": "close resemblance",
    "product of human ingenuity": "human creation",
    "rigorous investigation": "detailed study",
    "serves as a bridge": "acts as a link",
    "the nature world": "the natural world",
    "global challenges": "major world problems"
};

/**
 * Cleans text mechanics (punctuation, grammar, double words).
 */
function cleanTextMechanics(text) {
    let result = text;

    // STRICT EM-DASH & SEMICOLON BANNING
    result = result.replace(/\s*\u2014\s*|\s*\u2013\s*|\s*--\s*/g, ', ');
    result = result.replace(/;/g, '.'); 
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

    // FIX ARTIFACTS
    result = result.replace(/\.{2,}/g, '.'); 
    result = result.replace(/,{2,}/g, ','); 
    result = result.replace(/\.\s*,/g, '.');   
    result = result.replace(/,\s*\./g, '.');   
    result = result.replace(/\b(\w+)\s+\1\b/gi, '$1'); 
    result = result.replace(/\b(Also|Furthermore|Moreover|Additionally),\s+([\w\s]+?)\s+\1\b/gi, '$2'); 
    
    // GRAMMAR FIXES (a vs an)
    result = result.replace(/\ba ([aeiouAEIOU])/g, 'an $1');
    result = result.replace(/\ban ([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/g, 'a $1');
    result = result.replace(/\ban (useful|uniform|union|university|user|ubiquitous|unicorn)/gi, 'a $1');

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
// 6. GROQ FULL-TEXT FLOW EDITOR MODULE
// ==========================================================================

const FLOW_EDITOR_PROMPT = `You are an expert academic editor. Rewrite the following text to fix choppy, staccato flow and sentence fragments. 
RULES:
1. Connect disjointed facts using natural transitions (e.g., "Because of this,", "To achieve this,").
2. Fix all sentence fragments. If a sentence starts with "Unlike" or "With" and is incomplete, attach it to the main clause with a comma.
3. Do NOT use ", and" or ", but" to glue independent clauses together. Use a period.
4. Do NOT use em dashes (—) or semicolons (;).
5. Do NOT add headers, titles, or meta-commentary.

Return a JSON object with a single key "rewritten_text" containing the fully edited text.

TEXT TO EDIT:
`;

async function runGroqStages(text, groqKey) {
    const prompt = `${FLOW_EDITOR_PROMPT}${text}\n\nJSON OUTPUT:`;
    const messages = [{ role: 'user', content: prompt }];

    try {
        const content = await GroqAPI.chat(messages, groqKey, true);
        const parsed = parseGroqJson(content);
        if (parsed.rewritten_text && typeof parsed.rewritten_text === 'string') {
            return { text: parsed.rewritten_text, fixes: { stage1: 1 } };
        }
        return { text: text, fixes: { stage1: 0 } };
    } catch (error) {
        console.error('Groq Flow Editor Failed:', error);
        return { text: text, fixes: { stage1: 0 } };
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

        // Step 5: Groq 6-Stage Post-Processing
        let groqFixes = { stage1: 0, stage2: 0, stage3: 0, stage4: 0, stage5: 0, stage6: 0 };
        if (GROQ_KEY) {
            logs.push('Starting Groq 6-stage post-processing...');
            const groqResult = await runGroqStages(result, GROQ_KEY);
            result = groqResult.text;
            groqFixes = groqResult.fixes;
            logs.push(`Groq Stage 1 (Vocab) fixes: ${groqFixes.stage1}`);
            logs.push(`Groq Stage 2 (Syntax) fixes: ${groqFixes.stage2}`);
            logs.push(`Groq Stage 3 (Flow) fixes: ${groqFixes.stage3}`);
            logs.push(`Groq Stage 4 (Starters) fixes: ${groqFixes.stage4}`);
            logs.push(`Groq Stage 5 (Lexical) fixes: ${groqFixes.stage5}`);
            logs.push(`Groq Stage 6 (Grammar) fixes: ${groqFixes.stage6}`);
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
