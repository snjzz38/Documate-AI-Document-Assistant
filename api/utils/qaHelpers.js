// api/utils/qaHelpers.js
import { GroqAPI } from './groqAPI.js';
import { stripBecauseStarts, stripHollowFiller } from './textCleanup.js';

export const checkWithGroq = async (text, taskFmt, GROQ, budget) => {
    if (!GROQ || !text || !budget.spend('groq-qa')) return { pass: true };
    try {
        const messages = [
            { role: 'system', content: 'You are a QA checker. Return ONLY valid JSON. No thinking, no explanation.' },
            { role: 'user', content: `Check this academic text and return a JSON object with these boolean fields:
- "hasCommentary": true if ANY sentence comments on a source rather than arguing
- "hasBecauseStarts": true if ANY sentence or bullet starts with the word "Because"
- "hasMetaDescriptions": true if ANY sentence describes what a study IS rather than what it FOUND
- "headersIntact": true if section headers like "ARGUMENTS FOR", "DECISION:", "JUSTIFICATION:" each appear on their own line
- "bulletsCorrectLength": true if every bullet (lines starting with "- ") has 2-3 sentences (not more)
- "hasHollowAnalysis": true if ANY sentence follows evidence with hollow commentary like "This highlights the importance of...", "This underscores the need for...", "This demonstrates the significance of..." without naming a specific consequence
- "hasSameSourceClustering": true if the same citation (e.g. "(Smith, 2020)") appears in 3 or more consecutive sentences

TEXT:
${text}

Return ONLY the JSON object:` }
        ];
        const raw = await GroqAPI.chat(messages, GROQ, true);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { pass: true };
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error('[QA] Groq check failed:', e.message);
        return { pass: true };
    }
};

export const applyFixes = (text, checks) => {
    let result = text;
    result = stripBecauseStarts(result);
    result = stripHollowFiller(result);

    if (checks.hasCommentary || checks.hasMetaDescriptions || checks.hasHollowAnalysis) {
        result = result.replace(/\s*(?:Indeed|Furthermore|Moreover|Additionally|Specifically|However|Notably|Similarly),?\s+[A-Z][a-z]+(?:'s)?(?:\s+(?:et al\.|&\s+[A-Z][a-z]+))?(?:\s*\([^)]*\))?\s+(?:specifically |directly |further |also |particularly |effectively |powerfully )?(?:address|note|highlight|underscore|emphasize|articulate|expand|detail|elaborate|caution|warn|point out|stress|echo|summarize|demonstrate|reinforce|illustrate|review|discuss|analyze|examine|explore|assert|contend|observe|remark|acknowledge|confirm|corroborate|validate|support|reveal)[^.]*\./g, '');
        result = result.replace(/\s*[A-Z][a-z]+(?:\s+(?:et al\.|(?:and|&)\s+[A-Z][a-z]+))?\s*\(\d{4}\)\s+(?:specifically |directly |further |also |particularly |effectively |powerfully )?(?:address|note|highlight|underscore|emphasize|articulate|expand|detail|elaborate|caution|warn|point out|stress|echo|summarize|demonstrate|reinforce|illustrate|review|discuss|analyze|examine|explore|assert|contend|observe|remark|acknowledge|confirm|corroborate|validate|support|reveal)[^.]*\./g, '');
        result = result.replace(/\s*As\s+[A-Z][a-z]+(?:\s+(?:et al\.|(?:and|&)\s+[A-Z][a-z]+))?\s*\([^)]*\)\s+[^.]*\./g, '');
        result = result.replace(/\s*This\s+(?:highlights?|underscores?|emphasizes?|illustrates?|demonstrates?|confirms?|suggests?|shows?)\s+(?:the\s+)?(?:importance|significance|need|potential|concern|risk|inherent risk|imprudence|necessity)[^.]*\./g, '');
        result = result.replace(/\s*(?:This|Such)\s+(?:lack of|absence of|widespread impact|finding|result|evidence)\s+[^.]*(?:necessitates?|underscores?|highlights?|demonstrates?)[^.]*\./g, '');
        result = result.replace(/\s*Despite the [^,]+, this [^.]*(?:necessitates?|requires?|demands?)[^.]*\./g, '');
    }

    if (checks.bulletsCorrectLength === false) {
        result = result.replace(/^(\s*[-•]\s+)(.+)$/gm, (match, prefix, body) => {
            const sents = body.match(/[^.!?]+[.!?]+/g) || [body];
            if (sents.length > 3) return prefix + sents.slice(0, 3).join('').trim();
            return match;
        });
    }

    return result.replace(/  +/g, ' ').replace(/ +\n/g, '\n').trim();
};

export const runFinalQA = async (text, taskFmt, GROQ, budget) => {
    if (!GROQ || text.length < 1000) return text;
    try {
        const checks = await checkWithGroq(text, taskFmt, GROQ, budget);
        return applyFixes(text, checks);
    } catch (e) {
        return text;
    }
};
