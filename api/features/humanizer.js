// ==========================================================================
// FILE: api/features/humanizer.js
// DESCRIPTION: 
// A highly robust, surgical sentence-replacement humanizer. It utilizes 
// a programmatic fuzzy-matching algorithm to overcome LLM quotation typos, 
// prevents context-breaking word swaps, and forces deep syntactic clause 
// reconstruction on targeted sentences.
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
        if (bad === "critical") continue; // Handled contextually above
        
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
 * Calculates mathematical similarity between two string segments.
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
    
    return (2 * intersection) / (b1.size + b2.size);
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

const SURGICAL_PROMPT = `You are an expert academic editor. Analyze the formal/academic text below and identify every sentence that contains typical AI patterns, predictable structures, or balanced academic clichés.

For each identified sentence, provide a human-written rewrite that fits seamlessly within the surrounding context of the essay.

CRITICAL RULES FOR REWRITES:
1. FORCE DEEP SYNTACTIC RECONSTRUCTION (CLAUSE FLIPPING): Do not just swap words or use synonyms. You must completely reconstruct the grammar of the sentence. If the original sentence starts with the cause and ends with the effect, make your rewrite start with the effect and end with the cause.
   - Example original: "The greatest obstacle to deep-space exploration is gravity."
   - Example rewrite: "Gravity remains the single biggest hurdle we face in traveling further out."
   - Example original: "Fortunately, the rocky surfaces of the Moon and Mars are rich in minerals."
   - Example rewrite: "Luckily, we can find abundant minerals and metals directly on the lunar and Martian surfaces."
2. NO CLINICAL EXPANSION: Do not make the sentences longer or add complex AI-style noun expansions. Keep the replacements active, tight, and direct.
3. FORBIDDEN PHRASES: Do NOT use standard AI tropes like "represents a pivotal achievement", "renders... a tangible reality", "testament to", "revolutionize", "crucial enabler", or "plays a key role". Use natural academic phrasing.
4. NO CONVERSATIONAL FLUFF: Do NOT make the text informal, casual, or conversational. Do NOT add pacing phrases like "Think about it" or "Let's be honest." Keep the tone formal and scholarly.
5. EXACT MATCHING: The "original" key in your JSON object must match the targeted sentence in the text exactly, character-for-character, including capitalization and punctuation.
6. Pure JSON Output: Return only the JSON object matching the schema below. Do not wrap it in markdown code blocks. Do not add any conversational text before or after the JSON.

JSON SCHEMA:
{
  "replacements": [
    {
      "original": "The exact robotic sentence from the text",
      "replacement": "The highly natural, restructured formal academic replacement"
    }
  ]
}

TEXT TO ANALYZE:
`;

async function runSurgicalReplacements(text, groqKey) {
    const prompt = `${SURGICAL_PROMPT}\n"${text}"`;
    const messages = [{ role: 'user', content: prompt }];
    const appliedReplacements = [];

    try {
        const content = await GroqAPI.chat(messages, groqKey, true);
        const parsed = parseGroqJson(content);
        
        let result = text;
        // Split text into individual sentences, preserving trailing whitespace/punctuation
        const originalSentences = text.match(/[^.!?]+[.!?]+(?:\s|$)+/g) || [text];
        
        if (parsed && Array.isArray(parsed.replacements)) {
            for (const item of parsed.replacements) {
                if (item.original && item.replacement) {
                    const targetOriginal = item.original.trim();
                    const targetReplacement = item.replacement.trim();
                    
                    // Fuzzy-match: Find the closest sentence in the original text
                    let bestMatchIdx = -1;
                    let bestMatchScore = 0;
                    
                    for (let i = 0; i < originalSentences.length; i++) {
                        const score = getSentenceSimilarity(originalSentences[i].trim(), targetOriginal);
                        if (score > bestMatchScore) {
                            bestMatchScore = score;
                            bestMatchIdx = i;
                        }
                    }
                    
                    // Execute replacement if similarity is above 80%
                    if (bestMatchIdx !== -1 && bestMatchScore > 0.80) {
                        const matchedSentence = originalSentences[bestMatchIdx];
                        
                        // Escape regex characters of the actual matched sentence segment
                        const escapedMatch = matchedSentence.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const regex = new RegExp(escapedMatch, 'g');
                        
                        result = result.replace(regex, targetReplacement);
                        
                        appliedReplacements.push({ 
                            original: targetOriginal, 
                            matchedInText: matchedSentence.trim(),
                            replacement: targetReplacement,
                            similarityScore: bestMatchScore.toFixed(2),
                            status: "Fuzzy Match Replaced" 
                        });
                        
                        // Clear the index so it is not matched again
                        originalSentences[bestMatchIdx] = "";
                    } else {
                        appliedReplacements.push({ 
                            original: targetOriginal, 
                            replacement: targetReplacement,
                            status: "Failed to Match Text" 
                        });
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

        // Step 1: Run Groq Surgical Replacements Pass FIRST (analyzes original raw context)
        logs.push('Running targeted surgical replacement pass on Groq...');
        const surgicalResult = await runSurgicalReplacements(text, GROQ_KEY);
        let result = surgicalResult.text;
        logs.push('Surgical replacements complete');

        // Step 2: Apply vocabulary swaps SECOND (eliminates remaining AI words globally)
        result = applyWordSwaps(result, AI_VOCAB_SWAPS);
        result = applyWordSwaps(result, AI_STERILE_SWAPS);
        logs.push('Applied global word replacements');

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
