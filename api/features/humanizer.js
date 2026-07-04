// ==========================================================================
// FILE: api/features/humanizer.js
// DESCRIPTION: 
// Streamlined API route that humanizes AI text using Gemini and a highly
// optimized, single-pass Groq Master Polish stage. It resolves morphological 
// word-swap gaps, enforces high-variance human rhythm, and avoids brittle
// exact-match JSON replacements.
// ==========================================================================

import { GeminiAPI, getModelUsage as getGeminiUsage, resetModelUsage as resetGeminiUsage } from '../_utils/geminiAPI.js';
import { GroqAPI, getGroqModelUsage, resetGroqModelUsage } from '../_utils/groqAPI.js';

// ==========================================================================
// 1. CONFIGURATION & CONSTANTS (Expanded for complete morphology)
// ==========================================================================

const AI_VOCAB_SWAPS = {
    // utilize
    "utilize": "use", "utilizes": "uses", "utilizing": "using", "utilized": "used", "utilization": "use",
    // leverage
    "leverage": "use", "leverages": "uses", "leveraging": "using", "leveraged": "used",
    // facilitate
    "facilitate": "help", "facilitates": "helps", "facilitating": "helping", "facilitated": "helped", "facilitation": "help",
    // optimize
    "optimize": "improve", "optimizes": "improves", "optimizing": "improving", "optimized": "improved", "optimization": "improvement",
    // necessitate
    "necessitate": "require", "necessitates": "requires", "necessitating": "requiring", "necessitated": "required",
    // exacerbate
    "exacerbate": "worsen", "exacerbates": "worsens", "exacerbating": "worsening", "exacerbated": "worsened",
    // mitigate
    "mitigate": "reduce", "mitigates": "reduces", "mitigating": "reducing", "mitigated": "reduced", "mitigation": "reduction",
    
    // Formal transition words & clichés
    "furthermore": "also", "moreover": "also", "additionally": "also", "consequently": "so", 
    "nevertheless": "but", "therefore": "so", "thus": "so", "hence": "so", "whereby": "where",
    "crucial": "important", "essential": "needed", "significant": "major", "substantial": "large",
    "numerous": "many", "prudent": "wise", "in turn": "", "delve": "dig into", "delves": "explores",
    "notably": "especially", "foster": "build", "fosters": "builds", "fostering": "building",
    
    // Academic tells
    "objective discovery": "discovery", "objective discoveries": "discoveries",
    "pre-existing truths": "existing facts", "pre-existing": "existing",
    "predictability and effectiveness": "accuracy", "abstract tools": "mental tools",
    "social organization": "organizing society", "constant interaction": "interaction",
    "entirely separate existence": "independent reality", "extensive set": "large number",
    "supports the view": "argues", "holds that": "claims"
};

const AI_STERILE_SWAPS = {
    "regarding": "about",
    "represents a": "is a", "represents an": "is an", "represents the": "is the", "represents": "is",
    "abstract cognitive tools": "mental tools", "artificial logic exercise": "logic exercise",
    "societal organization": "organizing society", "limitless sequence": "endless sequence",
    "persist outside the mind": "exist outside the mind",
    "serving as": "acting as", "functioning as": "acting as", "act outside of": "exist outside of",
    "truly remarkable": "highly effective", "remarkable accomplishment": "major accomplishment",
    "fabric of the universe": "structure of reality", "fabric of reality": "structure of reality",
    "mortal invention": "human invention", "mortal creation": "human creation",
    "facilitated by this methodology": "helped by this approach",
    "in-depth analysis is facilitated": "detailed analysis is helped",
    "striking resemblance": "close resemblance", "product of human ingenuity": "human creation",
    "infinite array": "large number", "vast array": "large number",
    "rigorous investigation": "detailed study", "serves as a bridge": "acts as a link",
    "the nature world": "the natural world", "global challenges": "major world problems",
    "particularly when given": "especially when given"
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

async function groqLogicalChunk(text, groqKey) {
    const prompt = `You are an expert editor. Analyze the following text and group the sentences into logical paragraphs based on their topics. Do NOT change the wording of the sentences. Return a JSON object with a key "chunks" containing an array of strings.

TEXT:
${text}

JSON OUTPUT:`;

    const messages = [{ role: 'user', content: prompt }];
    try {
        const content = await GroqAPI.chat(messages, groqKey, true);
        const parsed = parseGroqJson(content);
        if (parsed.chunks && Array.isArray(parsed.chunks) && parsed.chunks.length > 0) {
            return parsed.chunks;
        }
        return splitIntoChunks(text);
    } catch (error) {
        console.error('Groq Logical Chunking Failed:', error);
        return splitIntoChunks(text);
    }
}

function applyWordSwaps(text, swapDict) {
    let result = text;
    for (const [bad, good] of Object.entries(swapDict)) {
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
        console.error('Failed to parse JSON:', error);
        return {};
    }
}

// ==========================================================================
// 3. PROMPT ENGINEERING MODULE
// ==========================================================================

function buildChunkPrompt(chunk, prevChunk, nextChunk) {
    let contextBlock = "";
    if (prevChunk || nextChunk) {
        contextBlock = `\nSURROUNDING CONTEXT (Use ONLY for flow alignment; do NOT rewrite this context):\nPREVIOUS TEXT: "${prevChunk || 'None'}"\nNEXT TEXT: "${nextChunk || 'None'}"\n`;
    }
    
    return `You are a professional human editor. Rewrite the text below to sound completely natural, organic, and human-written while keeping its original meaning.

${contextBlock}
TEXT TO REWRITE:
"${chunk}"

REWRITING DIRECTIONS:
1. HUMAN RHYTHM (BURSTINESS): Vary your sentence lengths drastically. Write some short, punchy sentences (3-7 words) right next to longer, fluid sentences (15-25 words). AI writes with uniform, monotonous sentence lengths; humans do not.
2. ABSOLUTELY NO 'WITH [NOUN] [VERB]-ING': Never write clauses like "X occurs, with craters hiding Y." Split them into active, separate sentences: "X occurs. Polar craters hide Y."
3. NO PARTICIPIAL ENDINGS: Never end sentences with a comma followed by an -ing verb (e.g., "X acts as a heavy anchor, severely limiting Y"). Rewrite them as: "X acts as a heavy anchor. This limits Y."
4. NO COMPOUND CONNECTORS: Do not glue clauses together using "while", "where", "which", or "allowing". Write short, direct sentences instead.
5. NO SEQUENCING OR LISTING: Never use sequential transitions such as "First", "Second", "Third", "Finally", "Lastly", "In addition", or "Furthermore". Instead, integrate these transitions smoothly as narrative statements without labeling them.
6. REMOVE ACADEMIC META-LANGUAGE: Present all ideas and arguments directly and assertively as facts without describing what the text or research is doing.

Output ONLY the rewritten text chunk, without quotes or commentary:`;
}

// ==========================================================================
// 4. LLM SERVICE MODULE
// ==========================================================================

async function humanizeChunk(chunk, prevChunk, nextChunk, apiKey, temperature) {
    const prompt = buildChunkPrompt(chunk, prevChunk, nextChunk);
    const raw = await GeminiAPI.chat(prompt, apiKey, temperature);
    return raw.trim().replace(/^["']|["']$/g, '');
}

// ==========================================================================
// 5. REGEX & ALGORITHMIC POST-PROCESSING MODULE
// ==========================================================================

const N_GRAM_FRICTION_MAP = {
    "space exploration": "off-world exploration",
    "space travel": "cosmic travel",
    "relies on mastering": "depends mostly on getting the hang of",
    "rely on mastering": "depend mostly on getting the hang of",
    "living off the land": "getting by on what we find on-site",
    "live off the land": "get by on what is found on-site",
    "heavy payloads": "massive shipments",
    "vital resources": "crucial raw materials",
    "vital resource": "crucial raw material",
    "hinge on": "come down to",
    "hinges on": "comes down to",
    "requires immense energy": "takes an incredible amount of power",
    "vast quantities": "massive amounts",
    "vast mineral": "huge mineral",
    "subsurface water": "underground water",
    "primary target": "main thing we need to find",
    "change everything": "upend how we do things",
    "revolutionize how": "totally alter the way",
    "simply too expensive": "flat-out unaffordable",
    "turn science fiction into reality": "make what sounded like science fiction actually happen",
    "turns science fiction into reality": "makes what sounded like science fiction actually happen",
    "venturing deeper": "traveling further out",
    "venture deeper": "travel further out",
    "permanent outposts": "long-term outposts",
    "permanent bases": "long-term bases",
    "astronaut life-support": "crew life-support",
    "humanity's relationship": "our relationship",
    "viewing ourselves as": "acting like mere",
    "true pioneers": "actual settlers"
};

/**
 * Helper to shuffle array elements in place.
 */
function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[arr[j]]] = [arr[arr[j]], arr[i]];
    }
    return arr;
}

/**
 * Cleans text mechanics (punctuation, grammar, double words).
 */
function cleanTextMechanics(text) {
    let result = text;

    // Convert em-dashes and semicolons to standard punctuation
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

    // FIX COHERENCE ARTIFACTS
    result = result.replace(/\.{2,}/g, '.'); 
    result = result.replace(/,{2,}/g, ','); 
    result = result.replace(/\.\s*,/g, '.');   
    result = result.replace(/,\s*\./g, '.');   
    result = result.replace(/\b(\w+)\s+\1\b/gi, '$1'); 
    result = result.replace(/\b(Also|Furthermore|Moreover|Additionally),\s+([\w\s]+?)\s+\1\b/gi, '$2'); 
    result = result.replace(/\b(\w+)\s+and\s+\1\b/gi, '$1'); 
    
    // Fix transitional anomalies
    result = result.replace(/\b[Bb]ut\s+[Hh]owever,?\s*/g, 'However, ');
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

/**
 * Programmatically breaks predictable AI word pairings (bigrams/trigrams)
 * and swaps them with lower-frequency human equivalents.
 */
function applyNGramFriction(text) {
    let result = text;
    for (const [aiPhrases, humanAlternative] of Object.entries(N_GRAM_FRICTION_MAP)) {
        const regex = new RegExp(`\\b${aiPhrases}\\b`, 'gi');
        result = result.replace(regex, (match) => {
            const isCapital = match[0] === match[0].toUpperCase();
            return isCapital 
                ? humanAlternative.charAt(0).toUpperCase() + humanAlternative.slice(1) 
                : humanAlternative;
        });
    }
    return result;
}

/**
 * Programmatically splits highly-identifiable AI compound clauses.
 * Swaps transitions with distinct, active sentence starters to alter syntax structure.
 */
function smashCompoundSentences(text) {
    let result = text;

    const smashMap = [
        { regex: /,\s+while\s+/gi, replacement: ". Meanwhile, " },
        { regex: /,\s+which\s+serves?\b/gi, replacement: ". This serves" },
        { regex: /,\s+which\s+will\b/gi, replacement: ". This will" },
        { regex: /,\s+which\s+plays?\b/gi, replacement: ". This plays" },
        { regex: /,\s+which\s+is\b/gi, replacement: ". This is" },
        { regex: /,\s+which\s+has\b/gi, replacement: ". This has" },
        { regex: /,\s+which\s+are\b/gi, replacement: ". These are" },
        { regex: /,\s+which\s+/gi, replacement: ". This " },
        { regex: /,\s+allowing\s+/gi, replacement: ". This allows " },
        { regex: /,\s+making\s+/gi, replacement: ". This makes " },
        { regex: /,\s+creating\s+/gi, replacement: ". This creates " },
        { regex: /,\s+severely\s+limiting\s+/gi, replacement: ". This severely limits " },
        { regex: /,\s+limiting\s+/gi, replacement: ". This limits " },
        { regex: /,\s+requiring\s+/gi, replacement: ". This requires " },
        { regex: /,\s+helping\s+/gi, replacement: ". This helps " },
        { regex: /,\s+resulting\s+in\s+/gi, replacement: ". This results in " },
        { regex: /,\s+triggering\s+/gi, replacement: ". This triggers " },
        { regex: /,\s+where\s+/gi, replacement: ". Here, " }
    ];

    for (const item of smashMap) {
        result = result.replace(item.regex, item.replacement);
    }

    return result;
}

/**
 * Artificially forces "burstiness" (sentence-length variance).
 * Programmatically inserts unique pacing breaks. Guarantees no phrase is repeated.
 */
function applyAlgorithmicBurstiness(text) {
    const paragraphs = text.split(/\n\n+/);
    const modifiedParagraphs = [];

    const uniquePaceBreakers = shuffleArray([
        "Think about it.",
        "Here is why.",
        "It is that simple.",
        "The data is clear on this.",
        "Let that sink in.",
        "But there is a catch.",
        "This is not a coincidence.",
        "Let's be honest.",
        "It gets worse.",
        "Here is the reality."
    ]);

    let breakerIndex = 0;

    for (let para of paragraphs) {
        const sentenceRegex = /[^.!?]+[.!?]+(?=\s|$)/g;
        let sentences = para.match(sentenceRegex) || [para];
        sentences = sentences.map(s => s.trim());

        if (sentences.length >= 3) {
            const counts = sentences.slice(0, 3).map(s => s.split(/\s+/).length);
            const range = Math.max(...counts) - Math.min(...counts);
            
            // If sentence length variance is too tight, inject a single unique pace breaker
            if (range <= 6 && breakerIndex < uniquePaceBreakers.length) {
                const randomBurst = uniquePaceBreakers[breakerIndex++];
                sentences.splice(2, 0, randomBurst);
            }
        }
        modifiedParagraphs.push(sentences.join(' '));
    }
    return modifiedParagraphs.join('\n\n');
}

/**
 * Artificially forces "perplexity" (predictability variance).
 * Randomly swaps common key transitions with random probabilities to bypass predictive models.
 */
function applyAlgorithmicPerplexity(text) {
    let result = text;

    const contractions = [
        { full: "does not", short: "doesn't" },
        { full: "is not", short: "isn't" },
        { full: "cannot", short: "can't" },
        { full: "will not", short: "won't" },
        { full: "do not", short: "don't" },
        { full: "it is", short: "it's" },
        { full: "there is", short: "there's" }
    ];

    for (const item of contractions) {
        const regex = new RegExp(`\\b${item.full}\\b`, 'gi');
        result = result.replace(regex, (match) => {
            if (Math.random() < 0.7) {
                const isCapital = match[0] === match[0].toUpperCase();
                return isCapital 
                    ? item.short.charAt(0).toUpperCase() + item.short.slice(1) 
                    : item.short;
            }
            return match;
        });
    }

    const synonymMap = {
        "important": ["critical", "key", "crucial", "essential", "central"],
        "primary": ["main", "chief", "primary", "central"],
        "influence": ["affect", "shape", "impact", "guide"],
        "unrelated": ["random", "seemingly random", "disconnected"],
        "polarization": ["division", "polarization", "ideological divide"]
    };

    for (const [word, synonyms] of Object.entries(synonymMap)) {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        result = result.replace(regex, (match) => {
            if (Math.random() < 0.5) {
                const chosen = synonyms[Math.floor(Math.random() * synonyms.length)];
                const isCapital = match[0] === match[0].toUpperCase();
                return isCapital 
                    ? chosen.charAt(0).toUpperCase() + chosen.slice(1) 
                    : chosen;
            }
            return match;
        });
    }

    return result;
}

// ==========================================================================
// 6. GROQ SINGLE-PASS MASTER SANITY POLISH
// ==========================================================================

const MASTER_POLISH_PROMPT = `You are a world-class editor correcting an academic essay to make it completely natural and human-written. 
Your goal is to inspect the draft, remove remaining AI tells, and output the polished, final copy.

INSTRUCTIONS:
1. DETECT & DESTROY AI WORDS: Replace remaining words like "facilitated", "leverage", "delve", "comprehensive", "robust", "demystify", "testament", "underpin", and "intricate" with direct, human alternatives.
2. ABSOLUTELY BAN 'with [noun] [verb]-ing' constructions (e.g., "X, with craters hiding Y"). Split them into completely separate, active sentences (e.g., "X. Polar craters hide Y").
3. NEVER end sentences with a comma followed by an -ing verb (e.g., "X, severely limiting Y"). Replace with a period and a direct statement: "X. This limits Y."
4. ABSOLUTELY BAN the words "while" or "where" as clause connectors (e.g., "bases act as gas stations, where spacecraft can refuel"). Split them into distinct sentences using periods: "bases act as gas stations. Spacecraft can refuel here."
5. NEVER use formal introductory clauses like "To establish permanent outposts, we need to...". Write directly: "Establishing permanent outposts requires us to..."
6. REMOVE SEQUENCING AND LISTING: Find and rewrite any lists using sequencing words (e.g., "First, ...", "Second, ...", "Finally, ..."). Convert them into fluid, flowing sentences and narrative connections.
7. HUMAN SENTENCE VARIETY (BURSTINESS): Ensure sentence length varies highly. Break down any long, overly academic, multi-clause sentences. If you find short, choppy fragments, merge them with adjacent sentences so they read naturally.
8. REMOVE META-LANGUAGE: Completely rewrite or strip expressions like "The evaluation in this essay...", "The analysis uses the framework...", or "This phenomenon warrants further investigation." State the claims directly instead of telling the reader what the essay is doing.
9. PERPLEXITY INJECTION: Use natural contractions ("doesn't", "it's", "can't") where appropriate to keep the language organic. 
10. NO SEMICOLONS OR EM-DASHES: Convert semicolons to periods and em-dashes to commas.
11. Absolutely do NOT write any meta-commentary, notes, or introduction. Return ONLY the polished text.

DRAFT TO POLISH:
`;

async function runGroqMasterPolish(text, groqKey) {
    const prompt = `${MASTER_POLISH_PROMPT}\n"${text}"`;
    const messages = [{ role: 'user', content: prompt }];

    try {
        const polishedText = await GroqAPI.chat(messages, groqKey, false);
        return polishedText.trim().replace(/^["']|["']$/g, '');
    } catch (error) {
        console.error('Groq Master Polish Failed:', error);
        return text; // Fallback to original text if the API fails
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
        const { text, apiKey, groqApiKey } = req.body;
        const GEMINI_KEY = apiKey || process.env.GEMINI_API_KEY;
        const GROQ_KEY = groqApiKey || process.env.GROQ_API_KEY;

        if (!text) throw new Error("No text provided.");
        if (!GEMINI_KEY) throw new Error("No Gemini API key provided.");

        logs.push(`Input: ${text.length} chars`);

        // Step 1: Initial word swaps on the full input
        let processed = applyWordSwaps(text, AI_VOCAB_SWAPS);
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

        const temperature = 0.75 + Math.random() * 0.15;
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
        let result = humanizedChunks.join('\n\n');
        result = postProcess(result);
        logs.push('Applied regex post-processing');

        // Step 5: Groq Consolidated Single-Pass Master Polish
        let groqSuccess = false;
        if (GROQ_KEY) {
            logs.push('Starting Groq Consolidated Master Polish...');
            result = await runGroqMasterPolish(result, GROQ_KEY);
            groqSuccess = true;
            logs.push('Completed Groq Master Polish Pass');
        } else {
            logs.push('Skipped Groq post-processing (no API key provided).');
        }

        // Step 6: Non-LLM Algorithmic Post-Processing
        logs.push('Applying non-LLM algorithmic adjustments...');
        result = applyNGramFriction(result);
        result = smashCompoundSentences(result);
        result = applyAlgorithmicBurstiness(result);
        result = applyAlgorithmicPerplexity(result);

        // Step 7: Final structural check and basic cleaning
        result = postProcess(result);
        result = applyWordSwaps(result, AI_VOCAB_SWAPS);

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
                masterPolishApplied: groqSuccess
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
