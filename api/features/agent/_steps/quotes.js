// ==========================================================================
// FILE PATH: api/features/agent/_steps/quotes.js
// ==========================================================================

/**
 * api/features/agent/_steps/quotes.js
 * Quote Insertion & Transition Step (Quotes Injector)
 * 
 * Table of Contents:
 * 1. Quote Insertion Step Executor Module
 */

import { GeminiAPI } from '../../../_utils/geminiAPI.js';
import { splitSentences, buildSourceDigest, buildEssayHTML, checkWithGroq, applyFixes } from '../_agentHelpers.js';

// ==========================================================================
// MODULE 1: Quote Insertion Step Executor
// ==========================================================================
export async function runQuotes({
    task,
    taskFormat,
    previousOutput,
    researchSources = [],
    citationStyle = 'apa7',
    quotesHandledInCite = false,
    sourceDigest = null
}, GEMINI, GROQ, budget) {
    const input = previousOutput || '';
    const taskFmt = taskFormat || 'general';

    if (!input || !researchSources.length) {
        return { text: input, outputHtml: buildEssayHTML(input) };
    }

    // Quotes already merged into CITE — run QA on previous cited text and exit
    if (quotesHandledInCite) {
        let cleaned = input;
        if (GROQ && input.length > 1000) {
            const checks = await checkWithGroq(input, GROQ, budget);
            cleaned = applyFixes(input, checks);
        }
        return { text: cleaned, outputHtml: buildEssayHTML(cleaned) };
    }

    // Task didn't ask for quotes — run QA and exit
    if (!/quote|evidence|support|direct quote/i.test(task || '')) {
        let cleaned = input;
        if (GROQ && input.length > 1000) {
            const checks = await checkWithGroq(input, GROQ, budget);
            cleaned = applyFixes(input, checks);
        }
        return { text: cleaned, outputHtml: buildEssayHTML(cleaned) };
    }

    const digest = sourceDigest || await buildSourceDigest(researchSources, citationStyle, GEMINI, budget);

    const availableQuotes = [];
    for (const [, d] of Object.entries(digest)) {
        for (const quote of d.quotes || []) {
            if (quote.length > 40) {
                availableQuotes.push({ quote, inTextKey: d.inTextKey, mainIdea: d.mainIdea });
            }
        }
    }

    if (!availableQuotes.length) {
        let cleaned = input;
        if (GROQ && input.length > 1000) {
            const checks = await checkWithGroq(input, GROQ, budget);
            cleaned = applyFixes(input, checks);
        }
        return { text: cleaned, outputHtml: buildEssayHTML(cleaned) };
    }

    const sentences = splitSentences(input);
    const numberedSentences = sentences.map((s, i) => `[${i}] ${s.trim()}`).join('\n');
    const quoteList = availableQuotes.slice(0, 8).map((q, i) =>
        `[${i}] ${q.inTextKey}: "${q.quote}"\n    Source about: ${q.mainIdea}`
    ).join('\n\n');

    const quotesPrompt = `You are inserting 2-3 direct quotes into an academic essay to support specific claims.

ESSAY SENTENCES (numbered by index):
${numberedSentences}

AVAILABLE QUOTES:
${quoteList}

RULES:
1. Return a JSON object: keys = sentence indices AFTER which to insert the quote block, values = the full insertion text
2. Insert EXACTLY 2-3 quotes total — spread across different sections, do NOT place two quotes consecutively
3. Only use quotes with SPECIFIC FINDINGS, DATA, or CONCRETE CONCLUSIONS — skip anything describing what a paper does
4. Do NOT insert into the DECISION section
5. Each inserted value must follow this structure:
   - Transition sentence explaining WHY this quote is relevant to the surrounding argument
   - The direct quote with citation: "..." (Author, Year).
   - Analysis sentence answering "So what?" — name the SPECIFIC implication, not a vague observation
6. FORBIDDEN analysis endings:
   "This highlights the importance of..." → FORBIDDEN
   "This underscores the need for..." → FORBIDDEN
   "This demonstrates the significance of..." → FORBIDDEN
   Instead name a concrete consequence: what breaks, what happens, who is affected and how.
7. Do NOT repeat content already stated in surrounding sentences

Return ONLY valid JSON:`;

    budget.spend('quotes-gemini');
    let withQuotes = input;
    try {
        const raw = await GeminiAPI.chat(quotesPrompt, GEMINI, 0.4);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const insertionMap = JSON.parse(jsonMatch[0]);
            const resultSentences = [];
            sentences.forEach((sentence, idx) => {
                resultSentences.push(sentence);
                if (insertionMap[String(idx)]) resultSentences.push(insertionMap[String(idx)]);
            });
            withQuotes = resultSentences.join(' ');
        }
    } catch (e) {
        console.error('[Quotes] JSON parse failed:', e.message);
    }

    let cleanedText = withQuotes;
    if (GROQ && withQuotes.length > 1000) {
        const checks = await checkWithGroq(withQuotes, GROQ, budget);
        cleanedText = applyFixes(withQuotes, checks);
    }

    return { text: cleanedText, outputHtml: buildEssayHTML(cleanedText) };
}