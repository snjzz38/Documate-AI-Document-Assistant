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
   - filterPlansForChunk(): Matches sentence plans with the correct chunk.
   - applyWordSwaps(): Case-preserving replacement of banned words.
   - parseGroqJson(): Safely parses JSON strings from Groq.
   - applyJsonReplacements(): Safely applies JSON before/after maps to text.
   - injectBurstiness(): Mechanically splits long sentences to increase burstiness.
   - mechanicalCommaBreaker(): Breaks repetitive relative clause commas.
   
3. PROMPT ENGINEERING MODULE
   - buildAnalysisPrompt(): Plans structural variations for formulaic thoughts.
   - buildChunkPrompt(): Directs specific syntactical modifications.
   
4. LLM SERVICE MODULE
   - parseGeminiJson(): Safely parses JSON output from Gemini.
   - analyzeText(): Runs the analytical pre-pass for structuring.
   - humanizeChunk(): Runs the actual rewriting pass on a chunk.
   
5. REGEX POST-PROCESSING MODULE
   - cleanTextMechanics(): Post-pass cleanup of punctuation and spacing.
   - postProcess(): Parent post-processing pipeline executor.
   
6. API HANDLER
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
    "in turn": "",
    
    // Generic Academic Tells (Universal)
    "unsustainable endeavor": "losing battle",
    "primary hurdle": "biggest roadblock",
    "severe limitations": "tight limits",
    "critical target": "main focus",
    "essential role": "big role",
    "entirely impractical": "impossible",
    "concrete reality": "reality",
    "tangible reality": "reality",
    "significant implications": "huge consequences",
    "vital linchpin": "linchpin",
    "vital supply stations": "supply stops",
    "treasure trove": "jackpot",
    "crucial aspect": "key detail",
    "formidable obstacle": "big problem",
    "significant shift": "huge change",
    "extended periods": "a long time",
    "profound shift": "massive change",
    "unlocked new possibilities": "opened new doors",
    "pressing concern": "big issue",
    "careful consideration": "attention",
    "detrimental impact": "bad effect",
    "upon employing": "by using",
    "sustenance": "support",
    "endeavors": "plans"
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
 * Filters the master list of restructuring plans to only include plans matching 
 * sentences present within the specific text chunk.
 */
function filterPlansForChunk(chunk, plans) {
    if (!plans || !Array.isArray(plans)) return [];
    return plans.filter(plan => {
        if (!plan || typeof plan.original !== 'string') return false;
        const cleanOriginal = plan.original.trim().toLowerCase();
        return chunk.toLowerCase().includes(cleanOriginal);
    });
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
 * Mechanically splits long sentences to increase burstiness while protecting flow.
 */
function injectBurstiness(text) {
    let sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    let result = [];

    for (let i = 0; i < sentences.length; i++) {
        let s = sentences[i].trim();
        let words = s.split(/\s+/);

        // Raised threshold to 32 words to avoid breaking structurally intact thoughts
        if (words.length > 32 && Math.random() > 0.4) {
            let splitIdx = words.findIndex((w, idx) => 
                idx > 12 && 
                idx < (words.length - 12) && 
                (w.toLowerCase() === 'and' || w.toLowerCase() === 'but' || w.toLowerCase() === 'while')
            );
            
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
    return result;
}

// ==========================================================================
// 3. PROMPT ENGINEERING MODULE
// ==========================================================================

/**
 * Step 1: Analyzes the text and plans structural variations.
 */
function buildAnalysisPrompt(text) {
    return `You are an expert writing analyst. Analyze the following text and identify up to 5 sentences that display highly predictable, formulaic structures (such as monotonous Subject-Verb-Object rhythms). 
For each, write a specific instruction on how to randomize its structure to sound more human and varied.
Examples of restructuring plans:
- "Invert sentence: lead with a dependent clause, prepositional phrase, or a gerund."
- "Break into a brief phrase followed by a longer descriptive sentence."
- "Shift the main verb or action to the beginning of the thought."
- "Inject a qualifier mid-sentence to interrupt the predictable cadence."

Do NOT plan or recommend or output trivial 3-to-5 word fragments (e.g. 'Mars holds ice.'). Ensure sentences retain descriptive depth.

Return a JSON object with a key "plans" containing an array of objects, each with "original" (the exact sentence from the text) and "plan" (the restructuring instruction).

TEXT TO ANALYZE:
 ${text}

JSON OUTPUT:`;
}

/**
 * Step 2: Builds a prompt designed to break Copyleaks' syllable, n-gram, and POS detection vectors.
 */
function buildChunkPrompt(chunk, plans) {
    let planBlock = "";
    if (plans && plans.length > 0) {
        planBlock = `\nRESTRUCTURE PLANS FOR THIS SPECIFIC CHUNK:\n${JSON.stringify(plans, null, 2)}\n`;
    }
    
    return `You are an expert editor. Rewrite the following text to sound completely human, natural, and engaging. 
    
CRITICAL ARCHITECTURAL SHIFT FOR BYPASSING DETECTORS:
- Do NOT perform a simple word-for-word translation. Re-order the ideas, combine adjacent thoughts, and collapse redundant sentences.
- Speak in an active, direct, and conversational voice (like a tech journalist writing an engaging column).
- MANDATORY: Use natural contractions everywhere (it's, won't, don't, can't, we've, there's, shouldn't, we're). Avoid formal, fully spelled-out word pairs.
- Inject occasional parenthetical remarks (like this one) to disrupt the sterile cadence of standard sentences.

${planBlock}
TEXT TO REWRITE:
"${chunk}"

STRICT RULES TO DEFEAT LINGUISTIC DETECTORS:
1. Output ONLY the rewritten text. No introductions, headers, meta-commentary, or markdown quotes.
2. EXTREME SYLLABLE CADENCE: Avoid writing sentences that have a similar length or syllable count. Put a very short sentence of 4-6 words (low syllable count) directly next to a massive, winding sentence of 25-35 words (high syllable count). 
3. SYNTACTIC VARIATION: Start some sentences with transition phrases, others with conditional clauses ("If we don't..."), and others with direct questions ("So, how do we fix this?"). Break the "Subject + Verb + Object" monotony.
4. BAN MECHANICAL HYPHENATION: Avoid mechanical hyphenated adjective compounds (e.g., do NOT write "carbon-dioxide-heavy sky" or "life-saving mission"). 
   Instead, write "sky heavy with carbon dioxide" or "mission to save lives." Keep hyphens to an absolute minimum.
5. ABSOLUTELY BAN cosmic, philosophical, or grand AI clichés (e.g., do NOT write "redefine our relationship with the universe", "transforming our understanding of the cosmos", "our place within it", "starkly highlights the enormity of the challenge", "underscores the imperative for innovative solutions"). Focus strictly on concrete physical facts.
6. BAN clichéd, empty one-liner transition sentences (e.g., do NOT write "It changes everything.", "This changes everything.", "It is a massive leap forward.", "It limits how far we go.", "It limits everything we can do.").
7. BAN trailing participle clauses (e.g., do NOT write "...with local materials, enabling us to print habitats" or "...electrolysis, highlighting the importance"). 
   Instead, use a conjunction ("and this lets us") or break the thought into a new sentence ("This lets us...").
8. BAN perfect participle openings (e.g., do NOT write "Having transcended our status..." or "Having completed the mission..."). Use active past or present perfect verbs instead.
9. ABSOLUTELY BAN em dashes (—), en dashes (–), or semicolons (;).

Output ONLY the rewritten chunk:`;
}

// ==========================================================================
// 4. LLM SERVICE MODULE
// ==========================================================================

/**
 * Parses JSON from Gemini (which doesn't support native JSON mode).
 */
function parseGeminiJson(raw) {
    try {
        const cleanJson = raw.replace(/^```json\s*|\s*```$/g, '').trim();
        return JSON.parse(cleanJson);
    } catch (e) {
        return { plans: [] };
    }
}

/**
 * Step 1: Calls Gemini to analyze the text and create restructuring plans.
 */
async function analyzeText(text, apiKey) {
    const prompt = buildAnalysisPrompt(text);
    const raw = await GeminiAPI.chat(prompt, apiKey, 0.5); // Low temp for analytical reasoning
    const parsed = parseGeminiJson(raw);
    return parsed.plans || [];
}

/**
 * Step 2: Calls Gemini to humanize a specific chunk of text using the plans.
 */
async function humanizeChunk(chunk, plans, apiKey, temperature) {
    const prompt = buildChunkPrompt(chunk, plans);
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
    "global challenges": "major world problems",
    "game changer": "major shift",
    "fundamentally alters": "changes",
    "feasibility of utilizing": "possibility of using",
    "feasibility of": "possibility of",
    "vast quantities of these deposits": "large amounts of these reserves",
    "pioneers can move beyond": "pioneers can get past",
    "long-term space travel becomes": "long-term space travel is",
    "eliminating the need for": "cutting out",
    "imposes severe limitations on": "places tight limits on"
};

/**
 * Master regex function to mechanically destroy AI tells, inject contractions, and fix grammar.
 */
function cleanTextMechanics(text) {
    let result = text;

    // 1. ABSOLUTE BAN ON EM DASHES, EN DASHES, AND DOUBLE HYPHENS
    result = result.replace(/[\u2014\u2013]|\s*--+\s*/g, ', ');
    result = result.replace(/;/g, '.'); 
    result = result.replace(/,\s*,/g, ',');

    // 2. CASE-PRESERVING MECHANICAL CONTRACTION ENGINE
    // Forces contractions on common word pairs to guarantee high human signature counts
    result = result.replace(/\bIs\s+not\b/g, "Isn't");
    result = result.replace(/\bis\s+not\b/g, "isn't");
    result = result.replace(/\bDo\s+not\b/g, "Don't");
    result = result.replace(/\bdo\s+not\b/g, "don't");
    result = result.replace(/\bDoes\s+not\b/g, "Doesn't");
    result = result.replace(/\bdoes\s+not\b/g, "doesn't");
    result = result.replace(/\bCannot\b/g, "Can't");
    result = result.replace(/\bcannot\b/g, "can't");
    result = result.replace(/\bWill\s+not\b/g, "Won't");
    result = result.replace(/\bwill\s+not\b/g, "won't");
    result = result.replace(/\bThere\s+is\b/g, "There's");
    result = result.replace(/\bthere\s+is\b/g, "there's");
    result = result.replace(/\bIt\s+is\b/g, "It's");
    result = result.replace(/\bit\s+is\b/g, "it's");
    result = result.replace(/\bWe\s+are\b/g, "We're");
    result = result.replace(/\bwe\s+are\b/g, "we're");
    result = result.replace(/\bThey\s+are\b/g, "They're");
    result = result.replace(/\bthey\s+are\b/g, "they're");
    result = result.replace(/\bYou\s+are\b/g, "You're");
    result = result.replace(/\byou\s+are\b/g, "you're");
    result = result.replace(/\bShould\s+not\b/g, "Shouldn't");
    result = result.replace(/\bshould\s+not\b/g, "shouldn't");
    result = result.replace(/\bWould\s+not\b/g, "Wouldn't");
    result = result.replace(/\bwould\s+not\b/g, "wouldn't");

    // 3. STERILE VOCABULARY SWAPS
    for (const [bad, good] of Object.entries(AI_STERILE_SWAPS)) {
        const regex = new RegExp(`\\b${bad}\\b`, 'gi');
        result = result.replace(regex, (match) => {
            if (match[0] === match[0].toUpperCase()) {
                return good.charAt(0).toUpperCase() + good.slice(1);
            }
            return good;
        });
    }

    // 4. MECHANICAL AI LOOP BREAKING
    result = mechanicalCommaBreaker(result);

    // 5. FIX ARTIFACTS
    result = result.replace(/\.{2,}/g, '.'); 
    result = result.replace(/,{2,}/g, ','); 
    result = result.replace(/\.\s*,/g, '.');   
    result = result.replace(/,\s*\./g, '.');   
    result = result.replace(/\b(\w+)\s+\1\b/gi, '$1'); // Double words
    result = result.replace(/\b(Also|Furthermore|Moving|Additionally),\s+([\w\s]+?)\s+\1\b/gi, '$2'); 

    // Eliminate empty, robotic transition clichés
    result = result.replace(/\b(It\s+changes\s+everything|This\s+changes\s+everything|It\s+is\s+a\s+massive\s+leap\s+forward)\.?\s*/gi, ' ');
    result = result.replace(/\b(It\s+limits\s+how\s+far\s+we\s+can\s+go|It\s+limits\s+everything\s+we\s+can\s+do)\.?\s*/gi, ' ');

    // Clean up generic academic/explanatory structures
    result = result.replace(/\bpressing\s+concern\s+that\s+warrants\s+careful\s+consideration\b/gi, 'big issue that needs attention');
    result = result.replace(/\bdetrimental\s+impact\b/gi, 'bad effect');
    result = result.replace(/\bin\s+this\s+regard\b/gi, 'here');
    result = result.replace(/\bupon\s+employing\b/gi, 'by using');
    result = result.replace(/\bparadigm\s+shift\b/gi, 'major shift');
    result = result.replace(/\bfar-reaching\s+implications\b/gi, 'huge consequences');

    // 6. CRITICAL PARTICIPLE CLAUSE BREAKS & CONVERSIONS
    result = result.replace(/,\s+fundamentally\s+altering\s+/gi, ' and changing ');
    result = result.replace(/,\s+altering\s+/gi, ' and changing ');
    result = result.replace(/,\s+underscoring\s+/gi, ' and underscores ');
    result = result.replace(/,\s+highlighting\s+/gi, ' and highlights ');
    result = result.replace(/,\s+enabling\s+/gi, ' and enables ');
    result = result.replace(/,\s+facilitating\s+/gi, ' and helps ');
    result = result.replace(/,\s+making\s+/gi, ' and makes ');
    result = result.replace(/,\s+paving\s+/gi, ' and paves ');
    result = result.replace(/,\s+demonstrating\s+/gi, ' and shows ');
    result = result.replace(/,\s+proving\s+/gi, ' and proves ');
    
    // Convert common AI relative clause loops (", thereby [verb]ing" -> " and [verb]ing")
    result = result.replace(/,\s+thereby\s+([a-z]+)ing/gi, ' and $1ing');
    result = result.replace(/,\s+thereby\s+/gi, ' and ');
    result = result.replace(/,\s+ensuring\s+/gi, ' and ensuring ');
    result = result.replace(/,\s+paving\s+the\s+way\s+for/gi, ' and opening doors for');
    
    // Clean up perfect participle leftovers (e.g. "Having transcended" -> "After transcending")
    result = result.replace(/\bHaving\s+transcended\s+/gi, 'Once we move past ');
    result = result.replace(/\bhaving\s+transcended\s+/gi, 'once we move past ');
    
    // 7. GRAMMAR FIXES (a vs an)
    result = result.replace(/\ba ([aeiouAEIOU])/g, 'an $1');
    result = result.replace(/\ban ([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/g, 'a $1');
    result = result.replace(/\ban (useful|uniform|union|university|user|ubiquitous|unicorn)/gi, 'a $1');

    // 8. SPACING & CAPITALIZATION
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
    
    // Mechanically split excessively long sentences to vary structure length safely
    result = injectBurstiness(result);
    
    return cleanTextMechanics(result);
}


// ==========================================================================
// 6. API HANDLER (Wiped out restructureSentences call)
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

        // Step 2: Gemini Analysis Pass (Identify robotic sentences)
        let plans = [];
        try {
            logs.push('Starting Gemini text analysis...');
            plans = await analyzeText(processed, GEMINI_KEY);
            logs.push(`Generated ${plans.length} restructuring plans.`);
        } catch (err) {
            logs.push(`Analysis failed (${err.message}), proceeding without plans.`);
        }

        // Step 3: Split into chunks
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

        // Step 4: Humanize chunks sequentially (Passing isolated plans)
        const humanizedChunks = [];
        for (let i = 0; i < chunks.length; i++) {
            try {
                // Filter plans so Gemini only sees the instructions relevant to this specific chunk
                const chunkPlans = filterPlansForChunk(chunks[i], plans);
                
                const humanized = await humanizeChunk(chunks[i], chunkPlans, GEMINI_KEY, temperature);
                humanizedChunks.push(humanized);
                logs.push(`Chunk ${i + 1}/${chunks.length}: OK (Applied ${chunkPlans.length} local plans)`);
            } catch (err) {
                logs.push(`Chunk ${i + 1}/${chunks.length}: FAILED (${err.message})`);
                humanizedChunks.push(chunks[i]);
            }
        }

        // Step 5: Rejoin and apply One Big Hardcoded Regex
        let result = humanizedChunks.join(' ');
        result = postProcess(result);
        logs.push('Applied master regex post-processing');

        // Step 6: Groq Targeted Sentence Restructuring has been completely removed
        // to prevent the formal academic regressions and AI paraphrasing signatures
        // previously introduced by Llama models.
        logs.push('Skipping Groq sentence restructuring to prevent formal regressions.');

        // Calculate final stats and usage
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
                fixesApplied: { restructures: 0 }
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


