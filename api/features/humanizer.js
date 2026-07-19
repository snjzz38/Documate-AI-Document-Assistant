// ==========================================================================
// FILE PATH: api/features/humanizer.js
// ==========================================================================

/**
 * api/features/humanizer.js
 * DocuMate High-Horizon Style Humanizer
 * 
 * Table of Contents:
 * 1. Configuration & Constants
 * 2. Text Utilities Module
 * 3. Prompt Engineering & Turnitin-Defying Examples Module
 * 4. LLM Service Module
 * 5. Regex Post-Processing Module
 * 6. API Handler Module
 */

import { GeminiAPI, getModelUsage as getGeminiUsage, resetModelUsage as resetGeminiUsage } from '../_utils/geminiAPI.js';
import { GroqAPI, getGroqModelUsage, resetGroqModelUsage } from '../_utils/groqAPI.js';

// ==========================================================================
// MODULE 1: CONFIGURATION & CONSTANTS
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
    "unlocked new possibilities": "opened doors", "detrimental impact": "bad effect",
    "pressing concern": "big issue", "careful consideration": "attention",
    "sustain": "support", "endeavors": "plans"
};

// ==========================================================================
// MODULE 2: TEXT UTILITIES
// ==========================================================================
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

function injectBurstiness(text) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    const result = [];

    for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i].trim();
        const words = s.split(/\s+/);

        // Mechanically disrupt repetitive sentence lengths (>30 words)
        if (words.length > 30 && Math.random() > 0.4) {
            const splitIdx = words.findIndex((w, idx) => 
                idx > 10 && 
                idx < (words.length - 10) && 
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

function mechanicalCommaBreaker(text) {
    let result = text;
    result = result.replace(/,\s+and\s+([A-Z][a-z])/g, '. $1');
    result = result.replace(/,\s+but\s+([A-Z][a-z])/g, '. But $1');
    return result;
}

// ==========================================================================
// MODULE 3: PROMPT ENGINEERING & EXAMPLES
// ==========================================================================
function buildFullTextPrompt(text) {
    return `You are a thoughtful human writer and researcher, not an AI. Rephrase the following text to sound completely natural, organic, and truly human-written.

Write with intellectual depth, but explain your ideas directly and simply—as if you are explaining your thesis to a smart colleague over coffee. 

DRAFT TO REWRITE:
"${text}"

SIMPLE WRITING RULES — STRONGLY ENFORCED:
1. NO OVERLY COMPLEX BUZZWORDS: Forbid overused academic "AI tells" (do NOT use words like: "precipitated", "encroaching", "dismantled", "scaffolding", "periphery", "conduits", "visceral", "affective", "autonomy", "electorate", "paradox"). Speak directly using natural words (like "barriers", "divide", "consensus", "influence", "voters", "choices", "rules", "decisions", "opinions") [3].
2. NO PARTICIPIAL CLAUSE CLUSTERS: Avoid overusing "-ing" participle clauses at the end of sentences (such as "...with social media fueling...", "...creating a systemic weakness..."). Write in clear, active main clauses instead.
3. ABSOLUTE BAN ON COLONS AND EM-DASHES: Do not use colons (:) or em-dashes (—) in the text unless they are part of a URL. Use standard periods or semicolons to separate your thoughts.
4. VARY SENTENCE LENGTHS: Mix extremely short sentences (8-12 words) with longer, sweeping sentences (25-35 words) naturally. Do not make every sentence the same length.
5. IMMUTABLE PLACEHOLDERS: Absolutely do NOT delete, alter, or translate any bracketed placeholders like "[CITE_0]" or "[CITE_1]". Keep them exactly where they are in their sentences.
6. Do NOT include any references or bibliographies in your output. Return ONLY the rewritten text itself.`;
}

// ==========================================================================
// MODULE 4: LLM SERVICE MODULE
// ==========================================================================
async function runStyleHumanizer(text, apiKey, temperature) {
    const prompt = buildFullTextPrompt(text);
    const raw = await GeminiAPI.chat(prompt, apiKey, temperature);
    return raw.trim().replace(/^["']|["']$/g, '');
}

// ==========================================================================
// MODULE 5: REGEX POST-PROCESSING
// ==========================================================================
const AI_STERILE_SWAPS = {
    "regarding": "about", "represents": "is", "serving as": "acting as",
    "functioning as": "acting as", "facilitated by": "helped by",
    "rigorous investigation": "detailed study", "serves as a bridge": "links",
    "global challenges": "major problems", "feasibility of": "possibility of",
    "eliminating the need for": "cutting out"
};

function cleanTextMechanics(text) {
    let result = text;

    // Programmatically disrupt EM dashes and semicolons to vary structural profiles
    result = result.replace(/[\u2014\u2013]|\s*--+\s*/g, ', ');
    result = result.replace(/;/g, '.'); 
    result = result.replace(/,\s*,/g, ',');

    // Case-preserving contraction engine (applied sparingly to protect academic tone)
    const contractions = [
        [/\bDo\s+not\b/g, "Don't"], [/\bdo\s+not\b/g, "don't"],
        [/\bCannot\b/g, "Can't"], [/\bcannot\b/g, "can't"],
        [/\bIt\s+is\b/g, "It's"], [/\bit\s+is\b/g, "it's"],
        [/\bWe\s+are\b/g, "We're"], [/\bwe\s+are\b/g, "we're"]
    ];
    contractions.forEach(([re, replace]) => { result = result.replace(re, replace); });

    // DETERMINISTIC SCHOLARLY TRANSITION DISRUPTOR (Keeps tone prestigious, avoiding casual slang) [3]
    result = result.replace(/\bHowever,\s+/gi, 'Yet, ');
    result = result.replace(/\bTherefore,\s+/gi, 'Thus, ');
    result = result.replace(/\bFurthermore,\s+/gi, 'Indeed, ');
    result = result.replace(/\bAdditionally,\s+/gi, 'Crucially, ');
    result = result.replace(/\bSpecifically,\s+/gi, 'To be exact, ');
    result = result.replace(/\bIn\s+fact,\s+/gi, 'Actually, ');
    result = result.replace(/\bUltimately,\s+/gi, 'In practice, ');
    result = result.replace(/\bConsequently,\s+/gi, 'As a result, ');
    result = result.replace(/\bMoreover,\s+/gi, 'Indeed, ');

    // Sterile Vocabulary Swaps
    for (const [bad, good] of Object.entries(AI_STERILE_SWAPS)) {
        const regex = new RegExp(`\\b${bad}\\b`, 'gi');
        result = result.replace(regex, (match) => {
            if (match[0] === match[0].toUpperCase()) {
                return good.charAt(0).toUpperCase() + good.slice(1);
            }
            return good;
        });
    }

    result = mechanicalCommaBreaker(result);

    // Clean up artifacts
    result = result.replace(/\.{2,}/g, '.'); 
    result = result.replace(/,{2,}/g, ','); 
    result = result.replace(/\.\s*,/g, '.');   
    result = result.replace(/\b(\w+)\s+\1\b/gi, '$1'); 

    // Grammar checks (a vs an)
    result = result.replace(/\ba ([aeiouAEIOU])/g, 'an $1');
    result = result.replace(/\ban ([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/g, 'a $1');
    result = result.replace(/\ban (useful|uniform|union|university|user|ubiquitous|unicorn)/gi, 'a $1');

    // NON-LISTING COLON PURGER: Replaces stylistic colons with sentence breaks and capitalizes the next word [1]
    result = result.replace(/(?<!https|http|doi):\s+([a-z])/g, (match, letter) => `. ${letter.toUpperCase()}`);

    // COLLAPSE SPACES BEFORE PUNCTUATION (Crucial anti-bot signature cleanup) [1]
    result = result.replace(/\s+([.,;:!?])/g, '$1');

    // Spacing
    result = result.replace(/,([a-zA-Z])/g, ', $1');
    result = result.replace(/\.([a-zA-Z])/g, '. $1');
    result = result.replace(/\s{2,}/g, ' ');
    
    result = result.replace(/([.!?]\s+)([a-z])/g, (m, punct, letter) => `${punct}${letter.toUpperCase()}`);
    result = result.replace(/^([a-z])/, (m, letter) => letter.toUpperCase());

    return result.trim();
}

function postProcess(text) {
    const result = text.replace(/[''`´]/g, "'").replace(/[""„]/g, '"');
    return cleanTextMechanics(result);
}

// ==========================================================================
// MODULE 6: API HANDLER
// ==========================================================================
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
        const { text, apiKey } = req.body;
        const GEMINI_KEY = apiKey || process.env.GEMINI_API_KEY;

        if (!text) throw new Error("No text provided.");
        if (!GEMINI_KEY) throw new Error("No Gemini API key provided.");

        logs.push(`Input: ${text.length} chars`);

        // Step 1: Programmatically isolate and mask all parenthetical citations (retains them 100% intact) [1]
        const citationsMap = [];
        let processed = text.replace(/\s*\([^)]+\)/g, (match) => {
            const placeholder = `[CITE_${citationsMap.length}]`;
            citationsMap.push({ placeholder, original: match.trim() });
            return ` ${placeholder} `;
        });
        logs.push(`Isolated and masked ${citationsMap.length} parenthetical citations.`);

        // Step 2: Initial word swaps on the masked input
        processed = applyWordSwaps(processed);

        const temperature = 0.72 + Math.random() * 0.25;
        logs.push(`Temperature: ${temperature.toFixed(2)}`);

        // Step 3: Executing streamlined, single-pass humanization
        logs.push('Executing single-pass humanization...');
        let result = await runStyleHumanizer(processed, GEMINI_KEY, temperature);

        // Step 4: Programmatically restore the exact original citations back into their placeholders [1]
        citationsMap.forEach(item => {
            result = result.split(item.placeholder).join(' ' + item.original + ' ');
        });
        logs.push('Restored all parenthetical citations.');

        // Step 5: Clean mechanics and spacing around the restored citations [1]
        result = postProcess(result);
        logs.push('Applied master post-processing');

        // Calculate final stats and usage
        const totalTimeMs = Date.now() - startTime;
        logs.push(`Final: ${result.length} chars`);

        const geminiUsage = getGeminiUsage();

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
            chunksProcessed: 1,
            gemini: {
                totalCalls: Object.values(geminiUsage).reduce((acc, m) => acc + m.success + m.failed, 0),
                modelsUsed: formatUsage(geminiUsage)
            },
            groq: { totalCalls: 0, modelsUsed: [] }
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
                groq: { totalCalls: 0, modelsUsed: [] }
            }
        });
    }
}