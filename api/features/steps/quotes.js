// api/features/steps/quotes.js
import { GeminiAPI } from '../../utils/geminiAPI.js';
import { splitSentences, cleanText, detectTaskFormat } from '../../utils/textCleanup.js';
import { buildSourceDigest } from '../../utils/citationHelpers.js';
import { buildEssayHTML } from '../../utils/htmlBuilders.js';
import { runFinalQA } from '../../utils/qaHelpers.js';

/**
 * Inserts 2–3 direct quotes into already-cited text.
 * If quotesHandledInCite is true (CITE already merged quotes in), this just
 * runs final QA and exits — no extra Gemini call.
 */
export async function runQuotes({
    task,
    previousOutput,
    researchSources = [],
    citationStyle = 'apa7',
    quotesHandledInCite = false,
    sourceDigest = null
}, GEMINI, GROQ, budget) {
    const input = previousOutput || '';
    const taskFmt = detectTaskFormat(task || '');

    if (!input || !researchSources.length) {
        return { text: input, outputHtml: buildEssayHTML(input) };
    }

    // Quotes already merged into CITE — just run final QA and exit
    if (quotesHandledInCite) {
        const cleaned = await runFinalQA(cleanText(input), taskFmt, GROQ, budget);
        return { text: cleaned, outputHtml: buildEssayHTML(cleaned) };
    }

    // Task didn't ask for quotes — still run QA
    if (!/quote|evidence|support|direct quote/i.test(task || '')) {
        const cleaned = await runFinalQA(input, taskFmt, GROQ, budget);
        return { text: cleaned, outputHtml: buildEssayHTML(cleaned) };
    }

    const digest = sourceDigest || await buildSourceDigest(researchSources, citationStyle, GEMINI, budget);

    const availableQuotes = [];
    for (const [, d] of Object.entries(digest)) {
        for (const quote of d.quotes) {
            if (quote.length > 40) {
                availableQuotes.push({ quote, inTextKey: d.inTextKey, mainIdea: d.mainIdea });
            }
        }
    }

    if (!availableQuotes.length) {
        const cleaned = await runFinalQA(input, taskFmt, GROQ, budget);
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

    withQuotes = cleanText(withQuotes);
    withQuotes = await runFinalQA(withQuotes, taskFmt, GROQ, budget);

    return { text: withQuotes, outputHtml: buildEssayHTML(withQuotes) };
}
