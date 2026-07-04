// ==========================================================================
// FILE: api/features/humanizer.js
// DESCRIPTION: 
// A highly optimized, surgical sentence-replacement humanizer. It identifies 
// and replaces every sentence containing heavy AI-predictability patterns, 
// preserves formal academic tone, avoids awkward programmatic pace-breakers, 
// and parses pure JSON response maps safely.
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
    
    // Formal Academic & Informational Tells
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
    "critical": "key"
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

// ==========================================================================
// 3. REGEX POST-PROCESSING MODULE
// ==========================================================================

function cleanTextMechanics(text) {
    let result = text;

    // Standard punctuation normalization
    result = result.replace(/\s*\u2014\s*|\s*\u2013\s*|\s*--\s*/g, ', ');
    result = result.replace(/;/g, '.'); 
    result = result.replace(/,\s*,/g, ',');

    // Spacing and duplicate cleanups
    result = result.replace(/\.{2,}/g, '.'); 
    result = result.replace(/,{2,}/g, ','); 
    result = result.replace(/\.\s*,/g, '.');   
    result = result.replace(/,\s*\./g, '.');   
    result = result.replace(/\s{2,}/g, ' ');
    
    return result.trim();
}

function postProcess(text) {
    let result = text;
    result = result.replace(/[''`´]/g, "'");
    result = result.replace(/[""„]/g, '"');
    return cleanTextMechanics(result);
}

// ==========================================================================
// 4. GROQ SURGICAL SENTENCE REPLACER MODULE
// ==========================================================================

const SURGICAL_PROMPT = `You are an expert academic editor. Analyze the formal/academic text below and identify every sentence that sounds robotic, has a predictable AI structure, or relies on common generative AI clichés (such as highly balanced parallel clauses, "rely on", "is crucial for", "plays a key role", passive verb chains, or formal introductory clauses like "To establish permanent outposts...").

For each identified sentence, provide a human-written rewrite that fits seamlessly within the surrounding context of the essay.

CRITICAL RULES:
1. NO CONVERSATIONAL FLUFF: Do NOT make the text informal, casual, or conversational. Do NOT add pacing phrases like "Think about it", "Let's be honest", or parenthetical fillers. The rewritten sentences must maintain a completely formal, analytical, scholarly, and academic tone.
2. ELIMINATE AI CLICHÉS: Do NOT use phrases like "represents a pivotal achievement", "renders... a tangible reality", "testament to", "revolutionize", or "crucial enabler". Use plain, active, and direct phrasing.
3. PRESERVE ALL FACTS: Keep every name (like MOXIE), number, data point, and scientific concept exactly as they are.
4. EXACT MATCHING: The "original" key in your JSON object must match the targeted sentence in the text EXACTLY, character-for-character, including capitalization and punctuation.
5. Pure JSON Output: Return only the JSON object matching the schema below. Do not wrap it in markdown code blocks. Do not add any conversational text before or after the JSON.

JSON SCHEMA:
{
  "replacements": [
    {
      "original": "The exact robotic sentence from the text",
      "replacement": "The highly natural, formal academic replacement"
    }
  ]
}

TEXT TO ANALYZE:
`;

async function runSurgicalReplacements(text, groqKey, trackingLogs) {
    const prompt = `${SURGICAL_PROMPT}\n"${text}"`;
    const messages = [{ role: 'user', content: prompt }];
    const appliedReplacements = [];

    try {
        const content = await GroqAPI.chat(messages, groqKey, true);
        const parsed = parseGroqJson(content);
        
        let result = text;
        if (parsed && Array.isArray(parsed.replacements)) {
            for (const item of parsed.replacements) {
                if (item.original && item.replacement) {
                    const originalClean = item.original.trim();
                    const replacementClean = item.replacement.trim();
                    const escapedOriginal = originalClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    
                    if (result.includes(originalClean)) {
                        const regex = new RegExp(escapedOriginal, 'g');
                        result = result.replace(regex, replacementClean);
                        appliedReplacements.push({ 
                            original: originalClean, 
                            replacement: replacementClean,
                            status: "Exact Match Replaced" 
                        });
                    } else {
                        // Fallback: search case-insensitively with flexible spacing
                        const flexibleRegex = new RegExp(escapedOriginal.replace(/\s+/g, '\\s+'), 'gi');
                        if (flexibleRegex.test(result)) {
                            result = result.replace(flexibleRegex, replacementClean);
                            appliedReplacements.push({ 
                                original: originalClean, 
                                replacement: replacementClean,
                                status: "Flexible Match Replaced" 
                            });
                        } else {
                            appliedReplacements.push({ 
                                original: originalClean, 
                                replacement: replacementClean,
                                status: "Failed to Match Text" 
                            });
                        }
                    }
                }
            }
        }
        return { text: result, replacements: appliedReplacements };
    } catch (error) {
        console.error('Surgical Replacements Pass Failed:', error);
        return { text, replacements: [] }; 
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

        // Step 1: Initial vocabulary replacements
        let result = applyWordSwaps(text, AI_VOCAB_SWAPS);
        result = applyWordSwaps(result, AI_STERILE_SWAPS);
        logs.push('Applied initial word replacements');

        // Step 2: Groq Surgical Replacements Pass
        logs.push('Running targeted surgical replacement pass on Groq...');
        const surgicalResult = await runSurgicalReplacements(result, GROQ_KEY, logs);
        result = surgicalResult.text;
        logs.push('Surgical replacements complete');

        // Step 3: Normalization and cleanup
        result = postProcess(result);
        result = applyWordSwaps(result, AI_VOCAB_SWAPS);

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

        // We return surgicalReplacements directly in the payload so you can debug the JSON in real time
        return res.status(200).json({ 
            success: true, 
            result, 
            logs,
            surgicalReplacements: surgicalResult.replacements,
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
