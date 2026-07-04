// ==========================================================================
// FILE: api/features/humanizer.js
// DESCRIPTION: 
// A highly robust, surgical humanizer optimized for LLaMA-3.1-8b. It forces 
// extreme syntactic simplicity (short, high-entropy sentences), utilizes 
// a programmatic fuzzy sentence matcher, and eliminates academic AI tells.
// ==========================================================================

import { GeminiAPI, getModelUsage as getGeminiUsage, resetModelUsage as resetGeminiUsage } from '../_utils/geminiAPI.js';
import { GroqAPI, getGroqModelUsage, resetGroqModelUsage } from '../_utils/groqAPI.js';

// ==========================================================================
// 1. CONFIGURATION & CONSTANTS
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
    
    // Academic Tells
    "significant": "major",
    "substantial": "large",
    "comprised of": "made of",
    "comprises": "includes",
    "comprising": "making up",
    "expenditure": "cost",
    "proportion": "part",
    "exorbitant": "steep",
    "fundamentally": "basically",
    "viability": "feasibility",
    "enabler": "factor",
    "prior to": "before",
    "subsequently": "later",
    "consequently": "so",
    "moreover": "also",
    "furthermore": "also",
    "additionally": "also",
    "vital": "important",
    "critical": "important"
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

function applyWordSwaps(text, swapDict) {
    let result = text;
    
    // Handle "critical" contextually to avoid "most key" errors
    result = result.replace(/(?<!most\s+)\bcritical\b/gi, "important");
    result = result.replace(/\bmost\s+critical\b/gi, "main");
    
    for (const [bad, good] of Object.entries(swapDict)) {
        if (bad === "critical") continue; 
        
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
 * Safely parses markdown JSON strings into a clean JavaScript object.
 */
function parseGroqJson(content) {
    try {
        const cleanJson = content.replace(/^```json\s*|\s*```$/g, '').trim();
        return JSON.parse(cleanJson);
    } catch (error) {
        console.error('Failed to parse JSON string:', error);
        return {};
    }
}

/**
 * Sorensen-Dice Bigram similarity coefficient.
 */
function getSentenceSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    if (s1 === s2) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0.0;
    
    const getBigrams = (str) => {
        const bigrams = new Set();
        for (let i = 0; i < str.length - 1; i++) {
            bigrams.add(str.substring(i, i + 2));
        }
        return bigrams;
    };
    
    const b1 = getBigrams(s1);
    const b2 = getBigrams(s2);
    
    let intersection = 0;
    for (const val of b1) {
        if (b2.has(val)) intersection++;
    }
    return intersection;
}

// ==========================================================================
// 3. REGEX POST-PROCESSING MODULE
// ==========================================================================

function cleanTextMechanics(text) {
    let result = text;

    result = result.replace(/\s*\u2014\s*|\s*\u2013\s*|\s*--\s*/g, ', ');
    result = result.replace(/;/g, '.'); 
    result = result.replace(/,\s*,/g, ',');

    result = result.replace(/\.{2,}/g, '.'); 
    result = result.replace(/,{2,}/g, ','); 
    result = result.replace(/\.\s*,/g, '.');   
    result = result.replace(/,\s*\./g, '.');   

    // GRAMMAR FIXES (a vs an)
    result = result.replace(/\ba ([aeiouAEIOU])/g, 'an $1');
    result = result.replace(/\ban ([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/g, 'a $1');
    result = result.replace(/\ban (useful|uniform|union|university|user|ubiquitous|unicorn)/gi, 'a $1');
    result = result.replace(/\ban discovery/gi, 'a discovery');
    result = result.replace(/\ban human/gi, 'a human');
    result = result.replace(/\bas means of/gi, 'as a means of');

    result = result.replace(/\s{2,}/g, ' ');
    
    return result.trim();
}

function postProcess(text) {
    let result = text;
    result = result.replace(/[''`´]/g, "'");
    result = result.replace(/[""„]/g, '"');
    return cleanTextMechanics(result);
}

/**
 * Programmatically splits highly-identifiable AI compound clauses.
 */
function smashCompoundSentences(text) {
    let result = text;

    const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

    const smashRules = [
        {
            regex: /,\s+while\s+/gi,
            replacements: [". Meanwhile, ", ". At the same time, ", ". On the flip side, "]
        },
        {
            regex: /,\s+with\s+the\s+/gi,
            replacements: [". Here, the ", ". At the same time, the ", ". For instance, the "]
        },
        {
            regex: /,\s+which\s+serves?\b/gi,
            replacements: [". This serves", ". It serves"]
        },
        {
            regex: /,\s+which\s+will\b/gi,
            replacements: [". This will", ". It will"]
        },
        {
            regex: /,\s+which\s+plays?\b/gi,
            replacements: [". This plays", ". It plays"]
        },
        {
            regex: /,\s+which\s+is\b/gi,
            replacements: [". This is", ". It is"]
        },
        {
            regex: /,\s+which\s+/gi,
            replacements: [". This ", ". It "]
        },
        {
            regex: /,\s+allowing\s+/gi,
            replacements: [". This lets ", ". Doing so allows "]
        },
        {
            regex: /,\s+making\s+/gi,
            replacements: [". That makes ", ". This makes "]
        },
        {
            regex: /,\s+creating\s+/gi,
            replacements: [". This creates ", ". It creates "]
        },
        {
            regex: /,\s+limiting\s+/gi,
            replacements: [". This limits ", ". It limits "]
        },
        {
            regex: /,\s+requiring\s+/gi,
            replacements: [". This requires ", ". It demands "]
        },
        {
            regex: /,\s+helping\s+/gi,
            replacements: [". This helps ", ". It helps "]
        },
        {
            regex: /,\s+resulting\s+in\s+/gi,
            replacements: [". This results in ", ". That leads to "]
        },
        {
            regex: /,\s+where\s+/gi,
            replacements: [". Here, ", ". At these bases, "]
        }
    ];

    for (const rule of smashRules) {
        result = result.replace(rule.regex, () => getRandom(rule.replacements));
    }

    return result;
}

// ==========================================================================
// 4. GROQ STYLE MIMICRY MODULE
// ==========================================================================

const STYLE_MIMICRY_PROMPT = `You are a student editor rewriting a draft for a class essay. Your goal is to rewrite the input text so it sounds like an earnest high school student wrote it.

STRICT WRITING RULES:
1. EXTREMELY SHORT SENTENCES: Every single sentence must be short and direct (between 5 and 12 words). Never write long, complex, or compound sentences. If a sentence has a comma, split it into two simple sentences.
2. USE CONTRACTIONS: You must use contractions naturally throughout the text (it's, there's, can't, don't, we're).
3. SIMPLE STUDENT VOCABULARY: Write in an earnest, straightforward voice. Use simple verbs like "is", "have", "need", "go", "get". Never use clinical, overly-polished, or academic words like "eschew", "hangs precariously", "linchpin", "recalibrates", "demands", "influence", "constrains", "harness", "prohibitively", or "tethered".
4. COMPLETE RECONSTRUCTION: Do not copy any full phrase from the input. Write every line from scratch in a simple, straightforward tone.
5. NO ACADEMIC TRANSITIONS: Never use transition words like "Furthermore", "Additionally", "Moreover", "On the other hand", "Therefore", or "Consequently". Just state the facts simply.

Output ONLY the simple, rewritten student essay. Do not add any introductory notes or wrap it in code blocks.

INPUT TEXT TO REWRITE:
`;

async function runStyleMimicry(text, groqKey) {
    const prompt = `${STYLE_MIMICRY_PROMPT}\n"${text}"`;
    const messages = [{ role: 'user', content: prompt }];

    try {
        const content = await GroqAPI.chat(messages, groqKey, false);
        return content.trim().replace(/^["']|["']$/g, '');
    } catch (error) {
        console.error('Style Mimicry Pass Failed:', error);
        return text; 
    }
}

// ==========================================================================
// 5. API HANDLER
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
        const { text, apiKey, groqApiKey } = req.body;
        const GROQ_KEY = groqApiKey || process.env.GROQ_API_KEY;

        if (!text) throw new Error("No text provided.");
        if (!GROQ_KEY) throw new Error("No Groq API key provided.");

        logs.push(`Input: ${text.length} chars`);

        // Step 1: Run Groq Style Mimicry Pass FIRST
        logs.push('Running targeted few-shot style mimicry pass on Groq...');
        let result = await runStyleMimicry(text, GROQ_KEY);
        logs.push('Style mimicry complete');

        // Step 2: Apply vocabulary swaps SECOND
        result = applyWordSwaps(result, AI_VOCAB_SWAPS);
        result = applyWordSwaps(result, AI_STERILE_SWAPS);
        logs.push('Applied global word replacements');

        // Step 3: Normalization, Punctuation Smashing, and cleanup
        result = smashCompoundSentences(result);
        result = postProcess(result);

        const totalTimeMs = Date.now() - startTime;
        logs.push(`Final output: ${result.length} chars`);

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
            groq: {
                totalCalls: Object.values(groqUsage).reduce((acc, m) => acc + m.success + m.failed, 0),
                modelsUsed: formatUsage(groqUsage)
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
        
        return res.status(500).json({ 
            success: false, 
            error: error.message, 
            logs,
            humanizer: {
                executionTimeMs: totalTimeMs
            }
        });
    }
}

export { 
    postProcess as PostProcessor, 
    AI_VOCAB_SWAPS, 
    applyWordSwaps
};
