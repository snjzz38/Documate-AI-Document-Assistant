// api/utils/citationHelpers.js
import { GeminiAPI } from './geminiAPI.js';
import { stripPreamble, stripMarkdown } from './textCleanup.js';

// ─── Author formatting ────────────────────────────────────────────────────────
export const fmtAuthorLastOnly = (s, style = 'apa') => {
    const authors = (s.authors || []).filter(a => a.family && a.family.length > 1);
    if (authors.length > 0) {
        if (authors.length === 1) return authors[0].family;
        if (authors.length === 2) return style === 'mla'
            ? `${authors[0].family} and ${authors[1].family}`
            : `${authors[0].family} & ${authors[1].family}`;
        return `${authors[0].family} et al.`;
    }
    const raw = (s.author || s.displayName || '').trim();
    if (!raw || raw === 'Unknown') return 'Unknown';
    const names = raw.split(/,\s*(?=[A-Z])|\s+(?:&|and)\s+/i).map(n => n.trim()).filter(Boolean);
    const last = n => n.split(/\s+/).pop();
    if (names.length === 1) return last(names[0]);
    if (names.length === 2) return style === 'mla'
        ? `${last(names[0])} and ${last(names[1])}`
        : `${last(names[0])} & ${last(names[1])}`;
    return `${last(names[0])} et al.`;
};

// ─── Citation insertion — appends citation before sentence's final punctuation ──
export const applyInsertions = (sentences, insertionMap) => {
    const result = [];
    sentences.forEach((sentence, idx) => {
        const key = String(idx);
        if (insertionMap[key]) {
            const punct = sentence.match(/([.!?]+)\s*$/)?.[1] || '';
            const base = sentence.replace(/[.!?]+\s*$/, '').trimEnd();
            result.push(`${base} ${insertionMap[key]}${punct}`);
        } else {
            result.push(sentence);
        }
    });
    return result.join(' ');
};

// ─── Source digest — summarizes sources + extracts usable quotes ────────────
// Single batched Gemini call regardless of source count (cost-capped).
export const buildSourceDigest = async (sources, style, GEMINI, budget) => {
    if (!budget.spend('digest-batch')) return {};

    const isApa = style.includes('apa');
    const isMla = style.includes('mla');
    const digest = {};
    const subset = sources.slice(0, 8);

    const entries = subset.map((s, i) => {
        const lastName = fmtAuthorLastOnly(s, isMla ? 'mla' : 'apa');
        const inTextKey = isApa
            ? `(${lastName}, ${s.year})`
            : isMla ? `(${lastName})` : `(${lastName} ${s.year})`;

        const abstract = (s.text || '').substring(0, 600) || '';
        const sentences = abstract.match(/[^.!?]+[.!?]+/g) || [];
        const isUseless = sent =>
            /\b(?:this|the present|our)\s+(?:article|paper|study|review)\b/i.test(sent) ||
            /\b(?:we|here)\s+(?:review|examine|discuss|present|describe|analyze)\b/i.test(sent) ||
            /\bthe\s+(?:aim|purpose|goal)\s+of\s+(?:this|the)\b/i.test(sent);

        const usableQuotes = sentences
            .filter(sent => sent.length > 40 && sent.length < 250 && !isUseless(sent))
            .slice(0, 2)
            .map(q => q.trim());

        return { s, i, inTextKey, abstract, usableQuotes };
    });

    const batchPrompt = entries.map(({ s, i, abstract }) => `[${i}]
Title: "${s.title}"
Abstract: ${abstract.substring(0, 500) || 'No abstract available.'}`).join('\n\n');

    let summaries = [];
    try {
        const response = await GeminiAPI.chat(`Summarize each source below in 1–2 sentences focusing ONLY on its main finding or argument. Be specific — state what it found, not what it discusses.

Return a JSON array ONLY, like:
[{"index":0,"summary":"..."},{"index":1,"summary":"..."}]

${batchPrompt}`, GEMINI, 0.3);
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch) summaries = JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error('[Citation] Digest batch failed:', e.message);
    }

    entries.forEach(({ s, i, inTextKey, abstract, usableQuotes }) => {
        const match = summaries.find(x => x.index === i);
        const mainIdea = match?.summary
            ? stripPreamble(stripMarkdown(match.summary)).trim()
            : abstract.substring(0, 150);
        const key = s.url || s.doi || s.id || s.title;
        digest[key] = { mainIdea, inTextKey, quotes: usableQuotes, source: s };
    });

    return digest;
};

// ─── Build the numbered source list block used in CITE prompts ──────────────
export const buildSourceListBlock = (sources, digest, style, limit = 12) => {
    const isApa = style.includes('apa');
    const isMla = style.includes('mla');
    return sources.slice(0, limit).map((s, i) => {
        const key = s.url || s.doi || s.id || s.title;
        const d = digest[key] || {};
        const lastName = fmtAuthorLastOnly(s, isMla ? 'mla' : 'apa');
        const inTextKey = isApa
            ? `(${lastName}, ${s.year})`
            : isMla ? `(${lastName})` : `(${lastName} ${s.year})`;
        return `[${i}] CITE-AS: ${inTextKey}\n    Main idea: ${d.mainIdea || (s.text || '').substring(0, 150)}\n    Title: "${s.title}"`;
    }).join('\n\n');
};

// ─── Sentence-level humanize+cite merge ──────────────────────────────────────
// Uses humanized phrasing where no citation is present; keeps cited sentences intact.
export const mergeHumanizeIntoCited = (humanizedText, citedText, splitSentences) => {
    const hasCitation = s => /\([A-Z][a-zA-Z\s,&.]+\d{4}\)|[¹²³⁴⁵⁶⁷⁸⁹⁰]/.test(s);
    const humanizedSents = splitSentences(humanizedText);
    const citedSents = splitSentences(citedText);
    const merged = citedSents.map((citedSent, i) =>
        hasCitation(citedSent) ? citedSent : (humanizedSents[i] || citedSent)
    );
    return merged.join(' ');
};
