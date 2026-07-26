// ==========================================================================
// FILE PATH: api/features/humanizer.js
// ==========================================================================

/**
 * api/features/humanizer.js
 * DocuMate Modular Humanizer v3.0
 * 
 * Architecture:
 * 1. Formality & Concept Classification (Groq)
 * 2. Narrative Segmentation (~10 Sentences)
 * 3. Contextual Dual-Pass JSON Pipelines (Sentence Restructuring & Lexical Editing)
 * 4. Citation Recovery & Stochastic Post-Processing
 */

import { GeminiAPI, getModelUsage as getGeminiUsage, resetModelUsage as resetGeminiUsage } from '../_utils/geminiAPI.js';
import { GroqAPI, getGroqModelUsage, resetGroqModelUsage } from '../_utils/groqAPI.js';

// ==========================================================================
// MODULE 1: CONFIGURATION & CONSTANTS
// ==========================================================================

/**
 * Style/personality variations rotated per section to create natural narrative variance.
 */
const SECTION_STYLES = [
    {
        name: 'Direct & Pragmatic',
        directive: 'Use shorter, punchier sentences. Minimize filler words and use strong active verbs.'
    },
    {
        name: 'Reflective & Rhythmic',
        directive: 'Incorporate asymmetric clauses, occasionally start a sentence with "But" or "And", and vary sentence lengths to establish a musical rhythm.'
    },
    {
        name: 'Analytical & Grounded',
        directive: 'Focus heavily on concrete details and crisp, logical bridges. Avoid airy generalizations.'
    },
    {
        name: 'Inquisitive & Conversational',
        directive: 'Introduce slight rhetorical pacing, using natural phrasing to make the reasoning feel discovered in real-time.'
    }
];

/**
 * Formality guidelines mapped to user choice. 
 * Directly guides structural and lexical choices in prompts.
 */
const FORMALITY_GUIDELINES = {
    basic: {
        tone: 'highly accessible, informal, and conversational',
        restructuring: 'Split complex ideas into short, conversational sentences. Use simple grammar.',
        lexical: 'Use simple, daily conversational words. Completely replace formal or academic terms.'
    },
    'semi-academic': {
        tone: 'intellectually curious, balanced, and readable',
        restructuring: 'Maintain logical progression, but make it sound like a thoughtful student writing a first draft.',
        lexical: 'Combine precise words with approachable academic transitions. Keep terms natural and clear.'
    },
    academic: {
        tone: 'rigorous, analytical, and authoritative yet human',
        restructuring: 'Use complex clauses, active academic vocabulary, and elegant sentence configurations.',
        lexical: 'Use precise, fitting, but uncommon academic terminology. Eliminate clichés.'
    },
    professional: {
        tone: 'direct, polished, clear, and business-focused',
        restructuring: 'Structure sentences for maximum clarity and immediate impact. Avoid passive voice.',
        lexical: 'Use sharp, standard industry-appropriate vocabulary while avoiding bloated corporate buzzwords.'
    }
};

/**
 * Stochastic transition pools used during final post-processing.
 */
const TRANSITION_POOLS = {
    however:    ['Yet', 'Still', 'That said', 'Even so', 'But', null],
    therefore:  ['So', 'Thus', 'Which means', 'As a result', null],
    furthermore:['Also', 'Plus', 'What\'s more', 'And', null],
    additionally:['Moreover', 'Besides', 'On top of that', null],
    consequently:['So', 'As a result', null],
    nevertheless:['Still', 'Even so', null],
    moreover:   ['Also', 'Besides', null],
    thus:       ['So', 'Because of this', null]
};

// ==========================================================================
// MODULE 2: SAFE TEXT UTILITIES & SEGMENTATION (UPGRADED)
// ==========================================================================

/**
 * Parses raw JSON output from model responses, handling potential markdown wrapping.
 */
function parseJSONResponse(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (innerErr) {
                throw new Error("Could not parse extracted JSON block: " + innerErr.message);
            }
        }
        throw new Error("No JSON object discovered in the response text.");
    }
}

/**
 * Balanced segmenter to prevent orphaned single-sentence blocks.
 */
function segmentText(text, targetSentenceCount = 8) {
    const sentences = text.match(/[^.!?]+[.!?]+(?:["'”’]?\s*|$)/g) || [text];
    const totalSentences = sentences.length;
    
    if (totalSentences <= targetSentenceCount + 2) {
        return [text.trim()];
    }
    
    const numChunks = Math.ceil(totalSentences / targetSentenceCount);
    const sentencesPerChunk = Math.ceil(totalSentences / numChunks);
    
    const sections = [];
    for (let i = 0; i < totalSentences; i += sentencesPerChunk) {
        sections.push(sentences.slice(i, i + sentencesPerChunk).join(' ').trim());
    }
    return sections;
}

/**
 * Safe sentence-replacement helper with defensive safeguards against invalid maps.
 */
function applySentenceReplacements(text, replacementMap) {
    let result = text;
    
    // Defensive Guard: Bypass gracefully if the map is null, undefined, or an array
    if (!replacementMap || typeof replacementMap !== 'object' || Array.isArray(replacementMap)) {
        vercelLog('apply_sentence_replacements_bypass', 'Bypassing structural replacements due to null or invalid map object.');
        return result;
    }
    
    for (const [original, replacement] of Object.entries(replacementMap)) {
        if (!original || !replacement || original.trim() === replacement.trim()) continue;
        
        let escapedOriginal = original.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        escapedOriginal = escapedOriginal.replace(/\s+/g, '\\s+');
        
        const regex = new RegExp(escapedOriginal, 'g');
        result = result.replace(regex, replacement);
    }
    return result;
}

/**
 * Safe word-replacement helper with defensive safeguards against invalid maps.
 */
function applyLexicalReplacements(text, replacementMap) {
    let result = text;
    
    // Defensive Guard: Bypass gracefully if the map is null, undefined, or an array
    if (!replacementMap || typeof replacementMap !== 'object' || Array.isArray(replacementMap)) {
        vercelLog('apply_lexical_replacements_bypass', 'Bypassing lexical replacements due to null or invalid map object.');
        return result;
    }
    
    for (const [original, replacement] of Object.entries(replacementMap)) {
        if (!original || !replacement || original.trim() === replacement.trim()) continue;

        let escapedOriginal = original.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        escapedOriginal = escapedOriginal.replace(/\s+/g, '\\s+');
        
        const isWord = /^\w/.test(original) && /\w$/.test(original);
        const regex = isWord ? new RegExp(`\\b${escapedOriginal}\\b`, 'gi') : new RegExp(escapedOriginal, 'gi');

        result = result.replace(regex, (match) => {
            if (match[0] === match[0].toUpperCase()) {
                return replacement.charAt(0).toUpperCase() + replacement.slice(1);
            }
            return replacement;
        });
    }
    return result;
}

/**
 * Extracts parenthetical citations so they aren't mangled by the model.
 */
function maskCitations(text) {
    const citationsMap = [];
    let counter = 0;
    
    const processed = text.replace(/\s*\([^)]*\d{4}[^)]*\)/g, (match) => {
        const placeholder = `[CITE_${counter}]`;
        citationsMap.push({
            placeholder,
            original: match.trim(),
            position: counter
        });
        counter++;
        return ` ${placeholder} `;
    });
    
    return { processed, citationsMap };
}

function restoreCitations(text, citationsMap) {
    let result = text;
    citationsMap.forEach(item => {
        if (result.includes(item.placeholder)) {
            result = result.split(item.placeholder).join(' ' + item.original + ' ');
            return;
        }
        const fuzzyRegex = new RegExp(`\\[?\\s*CITE_\\s*${item.position}\\s*\\]?`, 'gi');
        result = result.replace(fuzzyRegex, ' ' + item.original + ' ');
    });
    return result;
}

// ==========================================================================
// MODULE 3: INITIAL CLASSIFICATION & ASSESSMENT (Groq)
// ==========================================================================

/**
 * Cleanly prints structured debug payloads to Vercel's stdout.
 * Prefixed with [HUMANIZER_DEBUG] for easy filtering in the Vercel console.
 */
function vercelLog(label, payload) {
    console.log(`[HUMANIZER_DEBUG] >>> START: ${label.toUpperCase()} <<<`);
    if (payload && typeof payload === 'object') {
        console.log(JSON.stringify(payload, null, 2));
    } else {
        console.log(payload);
    }
    console.log(`[HUMANIZER_DEBUG] <<< END: ${label.toUpperCase()} >>>\n`);
}

/**
 * Request 1: Assess text formality level and summarize its core theme.
 */
async function classifyText(text, apiKey) {
    const prompt = `Analyze the writing signature of the following text to determine its current formality and underlying concept.

TEXT TO EVALUATE:
"${text.substring(0, 3000)}"

Respond with ONLY a valid raw JSON object. Do not include markdown codeblocks or conversational introductions. Match this schema exactly:
{
  "formality": "basic" | "semi-academic" | "academic" | "professional",
  "coreIdea": "A brief summary of the core thesis, claims, and goals of this text"
}`;

    vercelLog('groq_classification_prompt', prompt);

    const rawResponse = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        apiKey,
        false
    );
    
    vercelLog('groq_classification_raw_response', rawResponse);

    try {
        const parsed = parseJSONResponse(rawResponse.trim());
        vercelLog('groq_classification_parsed', parsed);
        return { prompt, rawResponse, parsed };
    } catch (err) {
        vercelLog('groq_classification_parse_error', err.message);
        throw err;
    }
}

async function getStructuralRestructuring(currentSection, previousSection, formality, coreIdea, sectionStyle, apiKey) {
    const contextStr = previousSection ? `PREVIOUS SECTION CONTEXT:\n"${previousSection}"\n\n` : '';
    const guidelines = FORMALITY_GUIDELINES[formality];

    const prompt = `You are an expert academic editor restructuring a draft.
Goal of Text: ${coreIdea}
Formality Level: ${formality} (${guidelines.tone})
Style Variation: ${sectionStyle.directive}

${contextStr}CURRENT SECTION TO REWRITE:
"${currentSection}"

STRICT COMPATIBILITY RULE:
You must synthesize the "Formality Level" with the "Style Variation". 
While executing sentence reordering, SVO flips, or sentence splitting, do NOT drop below the established "${formality}" register. Under no circumstances should you use overly conversational, simplified, or grade-school expressions (such as "help us talk" or "how we think as voters") if the target register is academic or semi-academic. Maintain intellectual rigor.

INSTRUCTIONS:
1. Identify 40% to 50% of the sentences in the CURRENT SECTION that sound structurally robotic or formulaic.
2. Completely restructure them to create asymmetric clause structures and human variance.
3. Ensure the sentence flows seamlessly with the PREVIOUS SECTION (if provided).
4. All CITATION placeholders (like [CITE_x]) must remain in the exact sentences they originated in.
5. Keep original keys VERBATIM, including the terminal punctuation (period, exclamation, or question mark) so they can be parsed correctly.

Respond with ONLY a valid raw JSON object. Match this format exactly:
{
  "Verbatim original sentence here.": "Restructured, elegant, and natural replacement sentence here."
}`;

    const rawResponse = await GeminiAPI.chat(prompt, apiKey, 0.7);
    return parseJSONResponse(rawResponse.trim());
}

// ==========================================================================
// MODULE 5: STOCHASTIC POST-PROCESSING & CLEANUP (UPGRADED)
// ==========================================================================

function applyStochasticTransitions(text, replacementProbability = 0.25) {
    let result = text;
    
    Object.entries(TRANSITION_POOLS).forEach(([word, pool]) => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        
        result = result.replace(regex, (match) => {
            if (Math.random() > replacementProbability) return match;
            
            const replacement = pool[Math.floor(Math.random() * pool.length)];
            if (replacement === null) return '';
            
            if (match[0] === match[0].toUpperCase()) {
                return replacement.charAt(0).toUpperCase() + replacement.slice(1);
            }
            return replacement;
        });
    });
    
    result = result.replace(/\s{2,}/g, ' ');
    return result;
}

function applySurfaceVariation(text) {
    let result = text;
    const preserveSemicolons = Math.random() > 0.5;
    const allowContractions = Math.random() > 0.3;
    
    if (!preserveSemicolons) {
        result = result.replace(/;/g, '.');
    }
    
    if (allowContractions) {
        const contractions = [
            [/\bDo not\b/g, "Don't", 0.3],
            [/\bdo not\b/g, "don't", 0.3],
            [/\bCannot\b/g, "Can't", 0.3],
            [/\bcannot\b/g, "can't", 0.3],
            [/\bIt is\b/g, "It's", 0.2],
            [/\bit is\b/g, "it's", 0.2]
        ];
        
        contractions.forEach(([pattern, replacement, prob]) => {
            if (Math.random() < prob) {
                result = result.replace(pattern, replacement);
            }
        });
    }
    
    return result;
}

/**
 * Upgraded recovery engine to systematically clean up formatting errors,
 * trailing commas/periods, and orphaned syntax chunks near citations.
 */
function conservativeCleanup(text) {
    let result = text;

    // 1. HEAL FRACTURED SENTENCES:
    // If a period is followed by a parenthetical citation and a lowercase letter (e.g., "...debate. (Aytac, 2022) and..."),
    // it means the sentence was incorrectly split. This removes the rogue period.
    result = result.replace(/\b([a-zA-Z]+)\.\s*(\([^)]+\))\s+([a-z])/g, "$1 $2 $3");

    // 2. HEAL DOUBLE PERIODS:
    // If there is a period before AND after a parenthetical citation (e.g., "citizens. (Aytac, 2022)."),
    // remove the first one to keep normal citation structure.
    result = result.replace(/\b([a-zA-Z]+)\.\s*(\([^)]+\))\s*\./g, "$1 $2.");

    // 3. HEAL CLASHING CLAUSTRAL PUNCTUATION:
    // Resolves rogue period-comma boundaries (e.g., "fracturing., (Zuiderveen)") by converting them 
    // to a unified trailing citation structure.
    result = result.replace(/\b([a-zA-Z]+)\.,\s*(\([^)]+\))/g, "$1 $2.");

    // 4. CLEANUP DOUBLE PUNCTUATION & SPACES:
    result = result.replace(/\s+([.,;:!?])/g, '$1');
    result = result.replace(/\.{2,}/g, '.');
    result = result.replace(/,{2,}/g, ',');
    result = result.replace(/\s{2,}/g, ' ');

    return result.trim();
}

function postProcess(text) {
    let result = text.replace(/[''`´]/g, "'").replace(/["""""„]/g, '"');
    result = applyStochasticTransitions(result, 0.25);
    result = applySurfaceVariation(result);
    result = conservativeCleanup(result);
    return result;
}

// ==========================================================================
// MODULE 6: SAFE API HANDLER (UPGRADED)
// ==========================================================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    const logs = [];
    const debugInfo = {
        classification: null,
        sections: []
    };
    const startTime = Date.now();
    
    resetGeminiUsage();
    resetGroqModelUsage();

    try {
        const { text, apiKey } = req.body;
        const GEMINI_KEY = apiKey || process.env.GEMINI_API_KEY;
        const GROQ_KEY = process.env.GROQ_API_KEY;

        if (!text) throw new Error("No text provided.");
        if (!GEMINI_KEY) throw new Error("No Gemini API key provided.");
        if (!GROQ_KEY) throw new Error("No Groq API key configured.");

        logs.push(`Input text size: ${text.length} characters.`);
        vercelLog('input_text_raw', text);

        // Step 1: Pre-process citations & extract writing structure
        const { processed: maskedText, citationsMap } = maskCitations(text);
        logs.push(`Masked ${citationsMap.length} citations for protection.`);
        vercelLog('masked_text_and_citations', { maskedText, citationsMap });

        // Step 2: Classify Formality Level via Groq
        logs.push("Running step 1: Formality classification and concept detection (Groq)...");
        let classResult;
        try {
            classResult = await classifyText(maskedText, GROQ_KEY);
        } catch (classErr) {
            logs.push(`Critical error: classification pass failed. Falling back to semi-academic. Error: ${classErr.message}`);
            classResult = {
                parsed: { formality: "semi-academic", coreIdea: "Academic draft about societal polarization and digital spaces" }
            };
        }
        
        const { formality, coreIdea } = classResult.parsed;
        debugInfo.classification = classResult;
        logs.push(`Classification success. Formality: ${formality}. Core Idea: "${coreIdea}"`);

        // Step 3: Segment document into balanced units
        const sections = segmentText(maskedText, 8);
        logs.push(`Segmented text into ${sections.length} balanced section(s).`);
        vercelLog('segmented_sections', sections);

        const processedSections = [];

        // Loop through segments performing dual structural & lexical edits safely
        for (let i = 0; i < sections.length; i++) {
            const currentSection = sections[i];
            const previousSection = i > 0 ? sections[i - 1] : null;
            const styleVariation = SECTION_STYLES[i % SECTION_STYLES.length];
            
            logs.push(`Processing Section ${i + 1}/${sections.length} with style "${styleVariation.name}"`);
            
            const sectionDiagnostics = {
                sectionIndex: i,
                originalText: currentSection,
                styleUsed: styleVariation.name,
                structural: null,
                lexical: null,
                finalText: null
            };

            // Step 2.1: Structural Restructure with safety fallback
            let structuralMap = {};
            try {
                const structResult = await getStructuralRestructuring(
                    currentSection,
                    previousSection,
                    formality,
                    coreIdea,
                    styleVariation,
                    GEMINI_KEY
                );
                
                if (structResult && structResult.parsed) {
                    structuralMap = structResult.parsed;
                    sectionDiagnostics.structural = structResult;
                }
            } catch (err) {
                logs.push(`Warning: Structural restructuring failed on Section ${i + 1}. Falling back to default section text.`);
                structuralMap = {}; // Reset to safe empty state
                sectionDiagnostics.structural = { error: err.message };
            }

            let restructuredSection = applySentenceReplacements(currentSection, structuralMap);
            vercelLog(`section_${i}_restructured_result`, restructuredSection);

            // Step 2.2: Lexical substitutions with safety fallback
            let lexicalMap = {};
            try {
                const lexResult = await getLexicalSubstitutions(
                    restructuredSection,
                    previousSection,
                    formality,
                    coreIdea,
                    styleVariation,
                    GEMINI_KEY
                );
                
                if (lexResult && lexResult.parsed) {
                    lexicalMap = lexResult.parsed;
                    sectionDiagnostics.lexical = lexResult;
                }
            } catch (err) {
                logs.push(`Warning: Lexical substitution failed on Section ${i + 1}. Falling back to clean structural state.`);
                lexicalMap = {}; // Reset to safe empty state
                sectionDiagnostics.lexical = { error: err.message };
            }

            let finalizedSection = applyLexicalReplacements(restructuredSection, lexicalMap);
            vercelLog(`section_${i}_finalized_result`, finalizedSection);
            
            sectionDiagnostics.finalText = finalizedSection;
            debugInfo.sections.push(sectionDiagnostics);
            
            processedSections.push(finalizedSection);
        }

        // Combine segments and restore citations
        let resultText = processedSections.join(' ');
        resultText = restoreCitations(resultText, citationsMap);
        logs.push("Citations restored successfully.");

        // Post-processing cleanup
        resultText = postProcess(resultText);
        logs.push("Post-processing variations and cleanups applied.");
        vercelLog('final_output_text', resultText);

        const totalTimeMs = Date.now() - startTime;
        const geminiUsage = getGeminiUsage();
        const groqUsage = getGroqModelUsage();

        const pipelineStats = {
            executionTimeSec: (totalTimeMs / 1000).toFixed(2),
            inputLength: text.length,
            outputLength: resultText.length,
            formalitySelected: formality,
            coreIdeaDetected: coreIdea,
            sectionsCount: sections.length,
            geminiCalls: Object.values(geminiUsage).reduce((acc, stats) => acc + stats.success + stats.failed, 0),
            groqCalls: Object.values(groqUsage).reduce((acc, stats) => acc + stats.success + stats.failed, 0)
        };

        return res.status(200).json({
            success: true,
            result: resultText,
            logs,
            debug: debugInfo,
            humanizer: pipelineStats
        });

    } catch (error) {
        const totalTimeMs = Date.now() - startTime;
        logs.push(`CRITICAL RUNTIME ERROR: ${error.message}`);
        vercelLog('critical_pipeline_error', { message: error.message, stack: error.stack });
        
        return res.status(500).json({
            success: false,
            error: error.message,
            logs,
            debug: debugInfo,
            humanizer: {
                executionTimeMs: totalTimeMs,
                status: "pipeline_failure"
            }
        });
    }
}