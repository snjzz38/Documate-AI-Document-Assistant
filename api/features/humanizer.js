// ==========================================================================
// FILE PATH: api/features/humanizer.js
// ==========================================================================

/**
 * api/features/humanizer.js
 * DocuMate Exemplar-Match Humanizer v2.0
 * 
 * Architecture: Persona-based reconstruction with stochastic surface variation,
 * signature analysis, and semantic validation.
 * 
 * Goal: Match the organic, specific, voice-driven quality of authentic 
 * high-performing student writing (Turnitin exemplar standard).
 * 
 * Table of Contents:
 * 1. Configuration & Constants
 * 2. Text Utilities Module (Signature Analysis & Extraction)
 * 3. Prompt Engineering & Persona Module
 * 4. LLM Service Module (Primary, Voice Injection, Validation)
 * 5. Stochastic Post-Processing Module
 * 6. API Handler Module
 */

import { GeminiAPI, getModelUsage as getGeminiUsage, resetModelUsage as resetGeminiUsage } from '../_utils/geminiAPI.js';
import { GroqAPI, getGroqModelUsage, resetGroqModelUsage } from '../_utils/groqAPI.js';

// ==========================================================================
// MODULE 1: CONFIGURATION & CONSTANTS
// ==========================================================================

/**
 * Stochastic transition pools.
 * Each array contains varied replacements + null (skip entirely).
 * The system randomly selects per-occurrence, preventing fingerprinting.
 */
const TRANSITION_POOLS = {
    however:    ['Yet', 'Still', 'That said', 'Even so', 'Then again', 'But', null],
    therefore:  ['So', 'Thus', 'Which means', 'As a result', 'That is why', null],
    furthermore:['Also', 'Plus', 'What\'s more', 'And', 'Beyond that', null],
    additionally:['Moreover', 'Besides', 'On top of that', null],
    consequently:['So', 'As a result', 'Because of this', null],
    nevertheless:['Still', 'Even so', 'All the same', null],
    moreover:   ['Also', 'Besides', 'What\'s more', null],
    thus:       ['So', 'Because of this', null],
    hence:      ['So', 'Which is why', null],
    ultimately: ['In the end', 'At bottom', null]
};

/**
 * Strategy definitions for the reconstruction pipeline.
 */
const STRATEGIES = {
    INVERSION: 'inversion',           // Invert logical flow
    VOICE_INJECTION: 'voice_injection', // Add personal asides/examples
    STRUCTURAL_SHUFFLE: 'structural_shuffle' // Reorder paragraphs/claims
};

/**
 * Persona templates that mimic authentic student voice.
 * Selected stochastically per-request to prevent model fingerprinting.
 */
const PERSONAS = [
    `You are a bright, slightly irreverent undergraduate who thinks through ideas on the page. 
You use specific personal examples, occasional rhetorical questions, and a mix of short punchy 
sentences with longer winding ones. You don't use fancy vocabulary to sound smart; you use 
precise words when they matter. You write like you're explaining something interesting to a 
professor you respect but aren't trying to impress with jargon.`,
    
    `You are a thoughtful college student writing a rough draft. You start with specific examples 
and build outward. You use first-person observations sparingly but effectively. Your transitions 
feel discovered, not inserted. You occasionally use conversational phrases like "Here's the thing" 
or "The catch is." You vary sentence length dramatically for rhythm.`,
    
    `You are an analytical student who questions ideas as you write. You use concrete scenarios 
(Wal-Mart, Instagram, Pandora) to ground abstract claims. You write with a formal-but-human tone: 
academic when discussing evidence, conversational when drawing conclusions. You are not afraid 
of a sentence fragment for emphasis.`
];

// ==========================================================================
// MODULE 2: TEXT UTILITIES (Signature Analysis & Extraction)
// ==========================================================================

/**
 * Analyzes the input text's statistical and stylistic signature.
 * Used to select reconstruction strategy and measure transformation.
 */
function analyzeWritingSignature(text) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    const sentenceLengths = sentences.map(s => s.trim().split(/\s+/).length);
    const avgLength = sentenceLengths.reduce((a, b) => a + b, 0) / (sentenceLengths.length || 1);
    const variance = sentenceLengths.reduce((acc, len) => acc + Math.pow(len - avgLength, 2), 0) / (sentenceLengths.length || 1);
    
    // Count formal transition words
    const formalTransitions = /\b(however|therefore|furthermore|additionally|consequently|nevertheless|moreover|thus|hence|ultimately)\b/gi;
    const transitionMatches = text.match(formalTransitions) || [];
    
    // Estimate lexical diversity (Type-Token Ratio proxy)
    const uniqueWords = new Set(words.map(w => w.toLowerCase().replace(/[^a-z]/g, ''))).size;
    const ttr = uniqueWords / (words.length || 1);
    
    // Detect AI-buzzword density
    const aiBuzzwords = /\b(utilize|leverage|facilitate|optimize|necessitate|exacerbate|mitigate|comprehensive|robust|crucial|essential|significant|substantial|numerous|prudent|endeavors|paradigm|synergy|holistic|actionable)\b/gi;
    const buzzwordCount = (text.match(aiBuzzwords) || []).length;
    
    return {
        sentenceCount: sentences.length,
        avgSentenceLength: parseFloat(avgLength.toFixed(2)),
        sentenceLengthVariance: parseFloat(variance.toFixed(2)),
        paragraphCount: paragraphs.length,
        avgParagraphLength: words.length / (paragraphs.length || 1),
        transitionDensity: parseFloat((transitionMatches.length / (sentences.length || 1)).toFixed(3)),
        lexicalDiversity: parseFloat(ttr.toFixed(3)),
        aiBuzzwordDensity: parseFloat((buzzwordCount / (words.length || 1)).toFixed(4)),
        hasPersonalVoice: /\b(I|my|we|our)\b/i.test(text),
        hasRhetoricalQuestion: /\?/.test(text)
    };
}

/**
 * Extracts argumentative claims and their associated evidence.
 * Used for semantic validation after reconstruction.
 */
function extractClaimGraph(text) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    const claims = [];
    
    sentences.forEach((sent, idx) => {
        const trimmed = sent.trim();
        // Heuristic: sentences with thesis-like markers or evidence markers
        const isClaim = /\b(argue|suggest|demonstrate|show|indicate|reveals?|means?|proves?)\b/i.test(trimmed);
        const hasEvidence = /\b(for example|for instance|specifically|in one case|according to)\b/i.test(trimmed);
        const hasCitation = /\[CITE_\d+\]|\([^)]*\d{4}[^)]*\)/.test(trimmed);
        
        if (isClaim || hasEvidence || hasCitation || idx === 0 || idx === sentences.length - 1) {
            claims.push({
                index: idx,
                text: trimmed,
                isClaim,
                hasEvidence,
                hasCitation
            });
        }
    });
    
    return claims;
}

/**
 * Isolates and masks parenthetical citations with semantic anchors.
 * More robust than simple string replacement.
 */
function maskCitations(text) {
    const citationsMap = [];
    let counter = 0;
    
    // Match parenthetical citations: (Author, Year), (Author et al., Year), etc.
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

/**
 * Restores citations with fuzzy matching in case LLM slightly alters placeholders.
 */
function restoreCitations(text, citationsMap) {
    let result = text;
    
    citationsMap.forEach(item => {
        // Exact match first
        if (result.includes(item.placeholder)) {
            result = result.split(item.placeholder).join(' ' + item.original + ' ');
            return;
        }
        
        // Fuzzy match: CITE_0 with optional spaces/brackets variations
        const fuzzyRegex = new RegExp(
            `\\[?\\s*CITE_\\s*${item.position}\\s*\\]?`,
            'gi'
        );
        result = result.replace(fuzzyRegex, ' ' + item.original + ' ');
    });
    
    return result;
}

// ==========================================================================
// MODULE 3: PROMPT ENGINEERING & PERSONA
// ==========================================================================

/**
 * Selects a random persona and strategy for this request.
 */
function selectPersonaAndStrategy(signature) {
    const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
    
    // Strategy selection informed by signature analysis
    let strategy = STRATEGIES.INVERSION;
    const rand = Math.random();
    
    if (signature.transitionDensity > 0.15) {
        // High formal transition density -> prioritize voice injection to break it up
        strategy = rand > 0.4 ? STRATEGIES.VOICE_INJECTION : STRATEGIES.INVERSION;
    } else if (signature.avgSentenceLength > 22) {
        // Very long sentences -> structural shuffle to break monotony
        strategy = rand > 0.3 ? STRATEGIES.STRUCTURAL_SHUFFLE : STRATEGIES.VOICE_INJECTION;
    } else {
        // Default weighted random
        if (rand < 0.5) strategy = STRATEGIES.INVERSION;
        else if (rand < 0.8) strategy = STRATEGIES.VOICE_INJECTION;
        else strategy = STRATEGIES.STRUCTURAL_SHUFFLE;
    }
    
    return { persona, strategy };
}

/**
 * Builds the primary reconstruction prompt.
 * Emphasizes organic student voice, specific examples, and structural asymmetry.
 */
function buildPrimaryPrompt(text, signature, persona, strategy) {
    const strategyInstructions = {
        [STRATEGIES.INVERSION]: `
STRUCTURAL INVERSION: If the original opens with a broad claim, start with a specific, 
concrete example. If it moves chronologically, rearrange to start with the implications. 
Invert the logical flow so the reader discovers the thesis through evidence rather than 
being told it upfront.`,
        
        [STRATEGIES.VOICE_INJECTION]: `
VOICE INJECTION: Add one or two brief first-person observations or specific hypothetical 
examples (like "shopping at Wal-Mart for a class assignment" or "scrolling through Instagram"). 
Include a rhetorical question. Make the argument feel like it is being thought through in 
real time, not delivered as a finished product.`,
        
        [STRATEGIES.STRUCTURAL_SHUFFLE]: `
STRUCTURAL SHUFFLE: Completely reorder the presentation of ideas. Combine claims that were 
separate. Split complex claims into shorter, punchier statements. Move the conclusion's insight 
to the introduction as a hook. Ensure the paragraph count and sentence count differ from the original.`
    };

    return `${persona}

You are rewriting the following academic draft. Your goal is to produce writing that matches 
the quality of a strong undergraduate essay: intellectually serious but organically human, 
with varied rhythm, specific examples, and natural transitions.

GOLD STANDARD QUALITIES TO EMULATE:
- Use precise but not pretentious vocabulary (e.g., "potent outlets," "compile your views," 
  "precisely aligned" — not "leverage" or "facilitate").
- Mix short declarative sentences (5-8 words) with longer complex ones (25-35 words).
- Use natural conversational-academic bridges: "The thing is," "Here's the catch," 
  "On the other hand," "That said," or skip transitions entirely between closely related ideas.
- Include specific, concrete scenarios rather than abstract generalizations.
- Write with a formal-but-human tone. Avoid clinical detachment. Avoid grade-school simplicity.
- Use absolute phrases and asymmetric clauses (e.g., "...with social media fueling divisions...").

${strategyInstructions[strategy]}

ORIGINAL DRAFT:
"${text}"

REWRITING RULES:
1. RADICAL REORGANIZATION: The sentence count, paragraph count, and structural sequence 
   must differ noticeably from the original. Do not perform a word-for-word paraphrase.
2. CITATION INTEGRITY: Every [CITE_X] token must remain embedded with its original claim. 
   As you move sentences, the citations travel with their semantic content.
3. NO COLONS AS CLAUSE JOINERS: Break those thoughts into separate sentences or use commas.
4. OUTPUT ONLY the rewritten text. No meta-commentary, no "Here is the rewrite:" introductions.
5. PRESERVE MEANING: Every argumentative claim and evidence point from the original must 
   appear in the rewrite, even if reordered or rephrased.`;
}

/**
 * Builds the secondary voice-enrichment prompt (Groq pass).
 * Focuses on surface-level organic variation without altering structure.
 */
function buildVoicePrompt(text) {
    return `You are a human academic editor polishing a student draft. Your job is to make 
the writing feel natural and slightly imperfect — the way a strong student actually writes.

TEXT TO EDIT:
"${text}"

EDITING RULES:
1. Preserve all [CITE_X] tokens exactly. Do not move, alter, or delete them.
2. If two consecutive sentences have similar length, change one to be much shorter or much longer.
3. Replace any stiff formal transitions with natural ones ("However" → "Yet" or "But"; 
   "Furthermore" → "Also" or just skip the transition).
4. Add one brief concrete example or personal aside if the text feels too abstract.
5. Ensure one sentence uses an absolute phrase or slightly asymmetric clause structure.
6. Output ONLY the edited text. No introductions or explanations.`;
}

/**
 * Builds the semantic validation prompt.
 */
function buildValidationPrompt(original, rewritten) {
    return `Compare the following ORIGINAL and REWRITTEN texts. 

ORIGINAL:
"${original.substring(0, 3000)}"

REWRITTEN:
"${rewritten.substring(0, 3000)}"

Evaluate on these criteria. Respond with ONLY a JSON object:
{
  "semanticPreservation": 0-100,
  "claimsIntact": true/false,
  "citationsIntact": true/false,
  "voiceQuality": 0-100,
  "issues": ["any problems found"]
}`;
}

// ==========================================================================
// MODULE 4: LLM SERVICE MODULE
// ==========================================================================

async function runPrimaryPass(text, apiKey, temperature, signature) {
    const { persona, strategy } = selectPersonaAndStrategy(signature);
    const prompt = buildPrimaryPrompt(text, signature, persona, strategy);
    
    const raw = await GeminiAPI.chat(prompt, apiKey, temperature);
    return {
        text: raw.trim().replace(/^["']|["']$/g, ''),
        strategy,
        persona: persona.substring(0, 100) + '...'
    };
}

async function runVoiceEnrichmentPass(text, apiKey) {
    const prompt = buildVoicePrompt(text);
    const raw = await GroqAPI.chat(
        [{ role: 'user', content: prompt }], 
        apiKey, 
        false
    );
    return raw.trim().replace(/^["']|["']$/g, '');
}

async function runValidationPass(original, rewritten, apiKey) {
    try {
        const prompt = buildValidationPrompt(original, rewritten);
        const raw = await GeminiAPI.chat(prompt, apiKey, 0.1);
        
        // Extract JSON from response
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return null;
    } catch (e) {
        return null;
    }
}

// ==========================================================================
// MODULE 5: STOCHASTIC POST-PROCESSING
// ==========================================================================

/**
 * Applies stochastic transition replacement.
 * Only affects ~30% of matched transitions, chosen randomly per-occurrence.
 */
function applyStochasticTransitions(text, replacementProbability = 0.3) {
    let result = text;
    
    Object.entries(TRANSITION_POOLS).forEach(([word, pool]) => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        let matchCount = 0;
        
        result = result.replace(regex, (match) => {
            matchCount++;
            // Stochastic: only replace some occurrences
            if (Math.random() > replacementProbability) return match;
            
            const replacement = pool[Math.floor(Math.random() * pool.length)];
            if (replacement === null) {
                // Skip transition entirely - capitalize next word if at sentence start
                return '';
            }
            
            // Preserve original case
            if (match[0] === match[0].toUpperCase()) {
                return replacement.charAt(0).toUpperCase() + replacement.slice(1);
            }
            return replacement;
        });
    });
    
    // Clean up double spaces left by null replacements
    result = result.replace(/\s{2,}/g, ' ');
    return result;
}

/**
 * Applies stochastic surface variation.
 * Randomly decides document-level style choices to prevent fingerprinting.
 */
function applySurfaceVariation(text) {
    let result = text;
    
    // Document-level coin flips (consistent within one document)
    const preserveSemicolons = Math.random() > 0.5;
    const preserveEmDashes = Math.random() > 0.6;
    const allowContractions = Math.random() > 0.3;
    
    if (!preserveEmDashes) {
        result = result.replace(/[\u2014\u2013]|\s*--+\s*/g, ', ');
    }
    
    if (!preserveSemicolons) {
        result = result.replace(/;/g, '.');
    }
    
    if (allowContractions) {
        // Sparse, stochastic contraction insertion
        const contractions = [
            [/\bDo not\b/g, "Don't", 0.3],
            [/\bdo not\b/g, "don't", 0.3],
            [/\bCannot\b/g, "Can't", 0.3],
            [/\bcannot\b/g, "can't", 0.3],
            [/\bIt is\b/g, "It's", 0.2],
            [/\bit is\b/g, "it's", 0.2],
            [/\bWe are\b/g, "We're", 0.2],
            [/\bwe are\b/g, "we're", 0.2]
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
 * Conservative cleanup: only fixes actual mechanical errors.
 * Preserves natural stylistic variation including intentional fragments.
 */
function conservativeCleanup(text) {
    let result = text;
    
    // Fix spacing around punctuation (anti-bot signature cleanup)
    result = result.replace(/\s+([.,;:!?])/g, '$1');
    result = result.replace(/,([a-zA-Z])/g, ', $1');
    result = result.replace(/\.([a-zA-Z])/g, '. $1');
    
    // Fix double punctuation
    result = result.replace(/\.{2,}/g, '.');
    result = result.replace(/,{2,}/g, ',');
    result = result.replace(/\.\s*,/g, '.');
    
    // Grammar: a vs an (conservative)
    result = result.replace(/\ba ([aeiouAEIOU])/g, 'an $1');
    result = result.replace(/\ban ([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/g, 'a $1');
    result = result.replace(/\ban (useful|uniform|union|university|user|ubiquitous|unicorn)/gi, 'a $1');
    
    // Sentence capitalization
    result = result.replace(/([.!?]\s+)([a-z])/g, (m, punct, letter) => `${punct}${letter.toUpperCase()}`);
    result = result.replace(/^([a-z])/, (m, letter) => letter.toUpperCase());
    
    // Clean up spaces
    result = result.replace(/\s{2,}/g, ' ');
    
    // Remove spaces before closing punctuation
    result = result.replace(/\s+([)\]])/g, '$1');
    
    return result.trim();
}

function postProcess(text) {
    let result = text.replace(/[''`´]/g, "'").replace(/["""""„]/g, '"');
    
    // Apply stochastic layers
    result = applyStochasticTransitions(result, 0.25); // 25% replacement rate
    result = applySurfaceVariation(result);
    result = conservativeCleanup(result);
    
    return result;
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
        const GROQ_KEY = process.env.GROQ_API_KEY;

        if (!text) throw new Error("No text provided.");
        if (!GEMINI_KEY) throw new Error("No Gemini API key provided.");

        logs.push(`Input: ${text.length} chars`);

        // Step 1: Signature Analysis
        const inputSignature = analyzeWritingSignature(text);
        logs.push(`Signature: avgLen=${inputSignature.avgSentenceLength}, var=${inputSignature.sentenceLengthVariance}, transDens=${inputSignature.transitionDensity}, buzzDens=${inputSignature.aiBuzzwordDensity}`);

        // Step 2: Extract claim graph for validation
        const claimGraph = extractClaimGraph(text);
        logs.push(`Extracted ${claimGraph.length} key claims/evidence sentences.`);

        // Step 3: Mask citations
        const { processed: maskedText, citationsMap } = maskCitations(text);
        logs.push(`Masked ${citationsMap.length} citations.`);

        // Step 4: Primary Reconstruction Pass (Gemini)
        const temperature = 0.75 + Math.random() * 0.2; // 0.75 - 0.95
        logs.push(`Temperature: ${temperature.toFixed(2)}`);
        
        logs.push('Executing primary persona-based reconstruction...');
        const primaryResult = await runPrimaryPass(maskedText, GEMINI_KEY, temperature, inputSignature);
        let result = primaryResult.text;
        logs.push(`Primary strategy: ${primaryResult.strategy}`);

        // Step 5: Secondary Voice Enrichment Pass (Groq) - stochastic
        if (GROQ_KEY && Math.random() > 0.3) { // 70% chance to run
            logs.push('Executing voice enrichment pass via Groq...');
            result = await runVoiceEnrichmentPass(result, GROQ_KEY);
            logs.push('Voice enrichment complete.');
        } else if (GROQ_KEY) {
            logs.push('Skipping voice enrichment (stochastic bypass).');
        }

        // Step 6: Restore citations
        result = restoreCitations(result, citationsMap);
        logs.push('Restored citations.');

        // Step 7: Stochastic post-processing
        result = postProcess(result);
        logs.push('Applied stochastic post-processing.');

        // Step 8: Semantic Validation (optional, if time permits)
        let validation = null;
        if (result.length < 4000) { // Only validate shorter texts to save tokens
            try {
                logs.push('Running semantic validation...');
                validation = await runValidationPass(text, result, GEMINI_KEY);
                if (validation) {
                    logs.push(`Validation: preservation=${validation.semanticPreservation}%, voice=${validation.voiceQuality}%`);
                    if (!validation.claimsIntact) {
                        logs.push('WARNING: Validation detected missing claims.');
                    }
                }
            } catch (valErr) {
                logs.push(`Validation skipped: ${valErr.message}`);
            }
        }

        // Step 9: Final signature analysis
        const outputSignature = analyzeWritingSignature(result);
        logs.push(`Output signature: avgLen=${outputSignature.avgSentenceLength}, var=${outputSignature.sentenceLengthVariance}, transDens=${outputSignature.transitionDensity}`);

        // Calculate stats
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
            inputSignature,
            outputSignature,
            primaryStrategy: primaryResult.strategy,
            validation,
            gemini: {
                totalCalls: Object.values(geminiUsage).reduce((acc, m) => acc + m.success + m.failed, 0),
                modelsUsed: formatUsage(geminiUsage)
            },
            groq: { 
                totalCalls: GROQ_KEY ? 1 : 0, 
                modelsUsed: [] 
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
