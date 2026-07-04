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
2. REMOVE ACADEMIC META-LANGUAGE: Do not write meta-commentary like "This essay will evaluate...", "The analysis focuses on...", or "The 3Cs framework is used to...". Instead, present the ideas and arguments directly and assertively as facts.
3. CONVERSATIONAL Academic Tone: Maintain an intellectual, educational tone, but write as if you are explaining the concept to a colleague. Replace overly stiff transitions ("Conversely", "Furthermore", "Consequently", "Ultimately") with natural alternatives ("But", "Also", "So", "In the end") or omit them entirely.
4. NO REPETITION: Do not reuse distinctive nouns or verbs within the same paragraph.
5. FLOW & FRAGMENTS: Ensure every sentence is a complete grammatical unit. Avoid starting sentences with awkward, hanging conjunctions unless they flow perfectly. Do not use em-dashes (—) or semicolons (;).

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
// 5. REGEX POST-PROCESSING MODULE
// ==========================================================================

function cleanTextMechanics(text) {
    let result = text;

    // Convert em-dashes and semicolons
    result = result.replace(/\s*\u2014\s*|\s*\u2013\s*|\s*--\s*/g, ', ');
    result = result.replace(/;/g, '.');
    result = result.replace(/,\s*,/g, ',');

    // Global cleanup of common artifacts
    result = result.replace(/\.{2,}/g, '.');
    result = result.replace(/,{2,}/g, ',');
    result = result.replace(/\.\s*,/g, '.');
    result = result.replace(/,\s*\./g, '.');
    result = result.replace(/\b(\w+)\s+\1\b/gi, '$1'); // Double words
    
    // Fix common bad transitions
    result = result.replace(/\b[Bb]ut\s+[Hh]owever,?\s*/g, 'However, ');
    result = result.replace(/,\s*However,/gi, '. However,');
    result = result.replace(/,\s*However\s/gi, '. However ');

    // Correct articles
    result = result.replace(/\ba ([aeiouAEIOU])/g, 'an $1');
    result = result.replace(/\ban ([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/g, 'a $1');
    result = result.replace(/\ban (useful|uniform|union|university|user|ubiquitous|unicorn)/gi, 'a $1');
    result = result.replace(/\ban discovery/gi, 'a discovery');
    result = result.replace(/\ban human/gi, 'a human');

    // Spacing
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
    result = cleanTextMechanics(result);
    return result;
}

// ==========================================================================
// 6. GROQ CONSOLIDATED MASTER SANITY POLISH (Single API Pass)
// ==========================================================================

const MASTER_POLISH_PROMPT = `You are a world-class editor correcting an academic essay to make it completely natural and human-written. 
Your goal is to inspect the draft, remove remaining AI tells, and output the polished, final copy.

INSTRUCTIONS:
1. DETECT & DESTROY AI WORDS: Replace remaining words like "facilitated", "leverage", "delve", "comprehensive", "robust", "demystify", "testament", "underpin", and "intricate" with direct, human alternatives.
2. HUMAN SENTENCE VARIETY (BURSTINESS): Ensure sentence length varies highly. Break down any long, overly academic, multi-clause sentences. If you find short, choppy fragments (like "Unlike platforms reliant on social connections."), merge them with adjacent sentences so they read naturally.
3. REMOVE META-LANGUAGE: Completely rewrite or strip expressions like "The evaluation in this essay...", "The analysis uses the 3Cs framework...", or "This phenomenon warrants further investigation." State the claims directly instead of telling the reader what the essay is doing.
4. PERPLEXITY INJECTION: Use natural contractions ("doesn't", "it's", "can't") where appropriate to keep the language organic. 
5. NO SEMICOLONS OR EM-DASHES: Convert semicolons to periods and em-dashes to commas.
6. Absolutely do NOT write any meta-commentary, notes, or introduction. Return ONLY the polished text.

DRAFT TO POLISH:
`;

async function runGroqMasterPolish(text, groqKey) {
    const prompt = `${MASTER_POLISH_PROMPT}\n"${text}"`;
    const messages = [{ role: 'user', content: prompt }];

    try {
        // Direct content edit (no complex JSON mapping needed)
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

        // Step 1: Initial morphological replacements
        let processed = applyWordSwaps(text, AI_VOCAB_SWAPS);
        processed = applyWordSwaps(processed, AI_STERILE_SWAPS);
        logs.push('Applied initial word swaps');

        // Step 2: Split into logical chunks
        let chunks = [];
        if (GROQ_KEY) {
            logs.push('Grouping paragraphs with Groq...');
            chunks = await groqLogicalChunk(processed, GROQ_KEY);
        } else {
            chunks = splitIntoChunks(processed, 4);
        }
        logs.push(`Split into ${chunks.length} paragraph blocks`);

        const temperature = 0.75 + Math.random() * 0.15;
        logs.push(`Temperature: ${temperature.toFixed(2)}`);

        // Step 3: Humanize chunks sequentially via Gemini
        const humanizedChunks = [];
        for (let i = 0; i < chunks.length; i++) {
            let prevChunk = i > 0 ? humanizedChunks[i - 1] : "";
            let nextChunk = i < chunks.length - 1 ? chunks[i + 1] : "";
            
            try {
                const humanized = await humanizeChunk(chunks[i], prevChunk, nextChunk, GEMINI_KEY, temperature);
                humanizedChunks.push(humanized);
                logs.push(`Chunk ${i + 1}/${chunks.length}: OK`);
            } catch (err) {
                logs.push(`Chunk ${i + 1}/${chunks.length}: FAILED (${err.message}). Using fallback.`);
                humanizedChunks.push(chunks[i]);
            }
        }

        // Step 4: Rejoin and apply regex mechanics
        let result = humanizedChunks.join('\n\n');
        result = postProcess(result);
        logs.push('Applied regex cleanups');

        // Step 5: Groq Consolidated Single-Pass Master Polish
        if (GROQ_KEY) {
            logs.push('Starting Groq Consolidated Master Polish...');
            result = await runGroqMasterPolish(result, GROQ_KEY);
            logs.push('Completed Master Polish pass');
        } else {
            logs.push('Skipped Groq post-processing (no API key provided).');
        }

        // Step 6: Final structural check
        result = postProcess(result);
        result = applyWordSwaps(result, AI_VOCAB_SWAPS);
        result = applyWordSwaps(result, AI_STERILE_SWAPS);

        const totalTimeMs = Date.now() - startTime;
        logs.push(`Final output: ${result.length} chars`);

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
    applyWordSwaps,
    splitIntoChunks
};
