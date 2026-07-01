// api/features/steps/cite.js
import { GeminiAPI } from '../../_utils/geminiAPI.js';
import { SourceFinderAPI } from '../../_utils/sourceFinder.js';
import {
    splitSentences, stripExistingCitations, stripSourceAppendix, stripRefs,
    cleanText
} from '../../_utils/textCleanup.js';
import {
    buildSourceDigest, buildSourceListBlock, applyInsertions
} from '../../_utils/citationHelpers.js';
import { buildBibliographyHTML, buildEssayHTML } from '../../_utils/htmlBuilders.js';
import { checkWithGroq, applyFixes } from '../../_utils/qaHelpers.js';

/**
 * Inserts citations (in-text, footnotes, or bibliography-only) into text.
 * Can optionally merge quote insertion into the same Gemini call when
 * enableQuotes is true and quotes are available — saves one round-trip.
 *
 *
 * Returns: { text, citedSources, bibliographyHtml, bibliographyPlain,
 *            sourceDigest, quotesHandledInCite }
 */
export async function runCite({
    task,
    previousOutput,
    researchSources = [],
    citationStyle = 'apa7',
    citationType = 'in-text',
    enableQuotes = false,
    preWarmedDigest = null
}, GEMINI, GROQ, budget) {
    const style = citationStyle;
    const type = (citationType || 'in-text').toLowerCase().trim();
    const isBibliographyOnly = type === 'bibliography';
    const isFootnotes = type === 'footnotes';
    const isApa = style.includes('apa');
    const isMla = style.includes('mla');

    const rawInput = (previousOutput || '').trim() || (task || '').trim();
    const input = stripExistingCitations(stripSourceAppendix(stripRefs(rawInput)));

    const sourcesWithCitations = researchSources.map(s => ({
        ...s,
        citation: s.citation || SourceFinderAPI._formatCitation(s, style)
    }));

    const finish = (essayText, citedSources, insertionOrder = null, extra = {}) => {
        const bib = buildBibliographyHTML(
            citedSources, style,
            isFootnotes ? 'footnotes' : 'bibliography',
            insertionOrder
        );
        return {
            text: essayText,
            outputHtml: buildEssayHTML(essayText),
            citedSources,
            bibliographyHtml: bib.html,
            bibliographyPlain: bib.plain,
            ...extra
        };
    };

    if (!sourcesWithCitations.length) return finish(input, []);
    if (!input) return finish('', sourcesWithCitations);

    if (isBibliographyOnly) {
        return finish(input, sourcesWithCitations);
    }

    // Reuse a pre-warmed digest (e.g. built concurrently during WRITE) if available
    const digest = preWarmedDigest && Object.keys(preWarmedDigest).length > 0
        ? preWarmedDigest
        : await buildSourceDigest(sourcesWithCitations, style, GEMINI, budget);

    const sentences = splitSentences(input);
    const sourceList = buildSourceListBlock(sourcesWithCitations, digest, style);
    const numberedSentences = sentences.slice(0, 25).map((s, i) => `[${i}] ${s.trim()}`).join('\n');

    if (isFootnotes) {
        return await citeFootnotes({ sentences, sourceList, numberedSentences, sourcesWithCitations, finish }, GEMINI, budget);
    }

    return await citeInText({
        sentences, sourceList, numberedSentences, digest,
        sourcesWithCitations, isApa, isMla, enableQuotes, finish
    }, GEMINI, GROQ, budget);
}

// ─── In-text citations (with optional merged quotes) ─────────────────────────
async function citeInText({
    sentences, sourceList, numberedSentences, digest,
    sourcesWithCitations, isApa, isMla, enableQuotes, finish
}, GEMINI, GROQ, budget) {
    const availableQuotes = [];
    for (const [, d] of Object.entries(digest)) {
        for (const q of d.quotes) {
            if (q.length > 40) availableQuotes.push({ quote: q, inTextKey: d.inTextKey, mainIdea: d.mainIdea });
        }
    }
    const mergeQuotes = enableQuotes && availableQuotes.length > 0;
    const citeFormat = isApa
        ? 'APA 7th: (LastName, Year) — use & not "and" for multiple authors'
        : isMla ? 'MLA 9th: (LastName)' : 'Chicago: (LastName Year)';

    let citePrompt;
    if (mergeQuotes) {
        const quoteList = availableQuotes.slice(0, 8).map((q, i) =>
            `[${i}] ${q.inTextKey}: "${q.quote}"\n    Source about: ${q.mainIdea}`
        ).join('\n\n');
        citePrompt = `Insert in-text citations AND 2–3 direct quotes into this academic text.

SENTENCES:
${numberedSentences}

SOURCES:
${sourceList}

AVAILABLE QUOTES:
${quoteList}

CITATION FORMAT: ${citeFormat}
Copy CITE-AS keys exactly — do not alter names, ampersands, or years.

Return JSON ONLY in this shape:
{
  "citations": { "sentence_index": "citation_string" },
  "quotes": { "sentence_index_to_insert_after": "full insertion block" }
}

Citations rules:
1. Distribute evenly across the text, do NOT cluster at end
2. Only cite sentences where the source is genuinely relevant
3. Max 2 consecutive sentences with the same citation

Quotes rules:
1. Insert EXACTLY 2–3 quotes — spread across different sections, never back-to-back
2. Only use quotes with SPECIFIC FINDINGS, DATA, or CONCRETE CONCLUSIONS
3. Do NOT insert into a DECISION section
4. Each inserted block must be: transition sentence → "quote" (Author, Year). → specific consequence
5. FORBIDDEN endings: "This highlights the importance of..." / "This underscores the need for..."
   Instead: name exactly what breaks, who is affected, or what specifically happens

Return ONLY valid JSON:`;
    } else {
        citePrompt = `You are inserting parenthetical in-text citations into an academic text.

SENTENCES (numbered by index):
${numberedSentences}

SOURCES:
${sourceList}

CITATION FORMAT: ${citeFormat}
Copy the CITE-AS key exactly — do not alter names, ampersands, or years.

RULES:
1. Return a JSON object: keys = sentence indices (strings), values = citation to append e.g. "(Smith & Jones, 2020)"
2. Distribute citations across the WHOLE text — do not cluster at the end
3. Only cite sentences where a source is genuinely relevant to the specific claim made
4. Duplicate citations of the same source at different locations ARE allowed
5. SOURCE DIVERSITY: Do not assign the same citation to more than 2 consecutive sentences
6. NEVER use footnote superscripts — ONLY parenthetical format
7. Do NOT add new sentences

Return ONLY valid JSON:`;
    }

    budget.spend('cite-gemini');
    try {
        const raw = await GeminiAPI.chat(citePrompt, GEMINI, 0.3);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const json = JSON.parse(jsonMatch[0]);
            const citationMap = mergeQuotes ? (json.citations || {}) : json;
            const quoteMap = mergeQuotes ? (json.quotes || {}) : {};

            const cited = applyInsertions(sentences, citationMap);

            let finalText = cited;
            if (mergeQuotes && Object.keys(quoteMap).length) {
                const citedSentences = splitSentences(cited);
                const withQuotesSentences = [];
                citedSentences.forEach((sentence, idx) => {
                    withQuotesSentences.push(sentence);
                    if (quoteMap[String(idx)]) withQuotesSentences.push(quoteMap[String(idx)]);
                });
                finalText = withQuotesSentences.join(' ');
            }

            const citedClean = cleanText(finalText);
            const extra = mergeQuotes ? { quotesHandledInCite: true, sourceDigest: digest } : { sourceDigest: digest };

            // Run QA here only when QUOTES step won't run separately — avoids double QA call
            if (!mergeQuotes && !enableQuotes && GROQ && citedClean.length > 1000) {
                const checks = await checkWithGroq(citedClean, GROQ, budget);
                return finish(applyFixes(citedClean, checks), sourcesWithCitations, null, extra);
            }
            return finish(citedClean, sourcesWithCitations, null, extra);
        }
    } catch (e) {
        console.error('[Cite] In-text JSON parse failed:', e.message);
    }

    return finish(splitSentences ? sentences.join(' ') : '', sourcesWithCitations, null, { sourceDigest: digest });
}

// ─── Footnotes ────────────────────────────────────────────────────────────────
async function citeFootnotes({ sentences, sourceList, numberedSentences, sourcesWithCitations, finish }, GEMINI, budget) {
    const footnotePrompt = `You are inserting superscript footnote numbers into an academic text.

SENTENCES (numbered by index):
${numberedSentences}

SOURCES:
${sourceList}

RULES:
1. Return a JSON object: keys = sentence indices (strings), values = superscript to append e.g. "¹" or "²"
2. Number footnotes sequentially (¹²³…) in order of first appearance in the text
3. The same source reused later gets the SAME superscript number
4. Distribute across the text — do not cluster at the end
5. SOURCE DIVERSITY: Do not assign the same superscript to more than 2 consecutive sentences
6. NEVER use parenthetical (Author, Year) format — ONLY superscript numbers
7. Do NOT add new sentences

Return ONLY valid JSON:`;

    budget.spend('cite-footnotes-gemini');
    try {
        const raw = await GeminiAPI.chat(footnotePrompt, GEMINI, 0.3);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const insertionMap = JSON.parse(jsonMatch[0]);
            const superToNum = { '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9, '⁰': 0 };
            const noteOrder = [];
            const seenSups = new Set();
            sentences.forEach((_, idx) => {
                const sup = insertionMap[String(idx)];
                if (sup && !seenSups.has(sup)) {
                    seenSups.add(sup);
                    const num = parseInt(String(sup).split('').map(c => superToNum[c] ?? 0).join(''));
                    const src = sourcesWithCitations[num - 1] || sourcesWithCitations[noteOrder.length];
                    if (src) noteOrder.push(src);
                }
            });
            const cited = applyInsertions(sentences, insertionMap);
            return finish(cited, sourcesWithCitations, noteOrder.length ? noteOrder : null);
        }
    } catch (e) {
        console.error('[Cite] Footnotes JSON parse failed:', e.message);
    }

    return finish(sentences.join(' '), sourcesWithCitations);
}
