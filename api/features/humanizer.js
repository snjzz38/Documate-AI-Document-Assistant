// ==========================================================================
// FILE: api/features/humanizer.js
// DESCRIPTION: 
// A style-mimicry humanizer. It utilizes a few-shot prompt structure trained
// directly on high-scoring Turnitin student exemplars to rewrite raw text 
// with natural sentence-length variation, mixed registers, and content-driven 
// transitions, followed by a global vocabulary cleaning pass.
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
    
    // Prevent "most key" errors by handling critical contextually
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

// ==========================================================================
// 4. GROQ FEW-SHOT STYLE MIMICRY MODULE
// ==========================================================================

const STYLE_MIMICRY_PROMPT = `You are a world-class academic editor and mimicry engine. Your sole goal is to completely translate the input text into the exact writing style, sentence structure, flow, and register shown in the human exemplar essays below.

--- START OF STYLE EXEMPLARS ---

EXEMPLAR 1: "No Matter the Cost of the Journey"
"The story Angela's Ashes, by Frank McCourt, and The Street, by Ann Petry, are two stories that express the mindset of perseverance. Angela's Ashes is a memoir from 1996 that describes the life of the author Frank McCourt growing up in Limerick, Ireland. Facing the challenges of these two harsh environments requires perseverance. This idea is explored and elucidated in both texts in a variety of ways, notably with the specific events, character development, and setting of the stories. McCourt decides to go out in search for food in the cold. When he comes across Kathleen O'Connell's shop and a bread delivery van outside, he contemplates stealing food from the shop. He thinks better of it at first because he knows it is the wrong thing to do, but he decides that the risk is worth taking, due to his unfortunate circumstances."

EXEMPLAR 2: "Ad Me"
"There’s definitely a major flaw to this system. It’s safe to say that the system does not know how to distinguish between sites that you actually use from sites that you just happen to visit. The Internet makes mistakes when forming your advertising identity because it has so many variables to deal with. For example, I had to go online to do an assignment which involved “shopping” at Wal-Mart and Sam’s Club. Now whenever I go onto a website, I see ads for Wal-Mart and pricing for curtains and children’s toys. These are not products I will need or use for a very long time, although the ad profile creating system has no way to differentiate whether you search something for a class assignment or whether you search it because you are actually interested in buying said items."

--- END OF STYLE EXEMPLARS ---

CRITICAL DIRECTIONS FOR THE REWRITE (MUST FOLLOW):
1. COMPLETE RECONSTRUCTION: You are strictly forbidden from copying any full sentence or structural template from the input text. Every single sentence must be completely rewritten from scratch. Do not just swap words; dismantle and rebuild the syntax.
2. SYNTACTIC FLIPPING: Invert the grammatical order of the clauses. If the original sentence starts with a cause and ends with an effect, flip it so your rewrite starts with the effect or completely changes the subject focus.
3. CONVERSATIONAL CONTRACTIONS: Use contractions (it's, there's, won't, don't, we're) naturally throughout your paragraphs.
4. MIXED REGISTER: Blend analytical terms (e.g., variables, process, feasibility) with direct, slightly informal human observations (e.g., "get by", "safe to say", "major flaw", "tethered to").
5. NO CHEAP SUFFIXES OR AI GIMMICKS: Do not append lazy, low-quality conversational tags like "really", "game-changer", "treasure trove" at the ends of your paragraphs. These sound artificial and trigger AI detectors. Write organic, cohesive, content-driven sentences instead.
6. NO STRUCTURAL SCAFFOLDING: Do not use transition words like "Furthermore", "In addition", "Moreover", or "On the other hand". Connect paragraphs using logical, story-driven bridging sentences.

Output ONLY the rewritten text, matching the academic level of the input but utilizing this exact human student style. Do not wrap the output in markdown code blocks. Do not add any introductory or concluding notes.

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

        // Step 1: Run Groq Style Mimicry Pass FIRST (processes entire text using human exemplar training)
        logs.push('Running targeted few-shot style mimicry pass on Groq...');
        let result = await runStyleMimicry(text, GROQ_KEY);
        logs.push('Style mimicry complete');

        // Step 2: Apply vocabulary swaps SECOND (eliminates remaining AI words globally)
        result = applyWordSwaps(result, AI_VOCAB_SWAPS);
        result = applyWordSwaps(result, AI_STERILE_SWAPS);
        logs.push('Applied global word replacements');

        // Step 3: Normalization and cleanup (does not rerun applyWordSwaps to avoid breaking grammar rules)
        result = postProcess(result);
        logs.push('Final normalization complete');

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
