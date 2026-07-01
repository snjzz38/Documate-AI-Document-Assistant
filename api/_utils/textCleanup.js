// api/_utils/textCleanup.js

// ─── Basic strips ─────────────────────────────────────────────────────────────

export const stripMarkdown = t => t
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/`([^`]+)`/g, '$1');

export const stripPreamble = t => t
    .replace(/^(?:(?:Here(?:'s| is)|Sure[,!]?\s*(?:here(?:'s| is))?|Okay[,!]?\s*(?:here(?:'s| is))?|Certainly[,!]?\s*(?:here(?:'s| is))?|I'(?:ve|ll)|Below is|The following is)[^\n]*\n)+/i, '')
    .trim();

export const stripBecauseStarts = text => text
    .replace(/^(\s*[-•]\s+)Because\s+([a-z])/gm, (_, prefix, c) => prefix + c.toUpperCase())
    .replace(/^Because\s+([a-z])/gm, (_, c) => c.toUpperCase())
    .replace(/([.!?]\s+)Because\s+([a-z])/g, (_, punct, c) => punct + c.toUpperCase());

// ─── Strip hollow filler sentences ───────────────────────────────────────────
export const stripHollowFiller = text => text
    .replace(/\s*The potential for [^.!?]+ is (?:undeniable|significant|clear|substantial|tremendous)[^.!?]*\./gi, '')
    .replace(/\s*The prospect of [^.!?]+ raises serious concerns[^.!?]*\./gi, '')
    .replace(/\s*(?:the )?(?:process|approach|technology|method) is not without (?:risk|challenge|issue|concern)[^.!?]*\./gi, '')
    .replace(/\s*When (?:researchers?|scientists?|we) (?:gain|develop|uncover|discover)[^.!?]+(?:paves the way for|opens doors to|enables)[^.!?]*\./gi, '')
    .replace(/  +/g, ' ').replace(/ +\n/g, '\n').trim();

export const stripRefs = t => t
    .replace(/\n\n\*?\*?(?:APA References?|References?|Works Cited|Bibliography|Notes)[:\s]*\*?\*?[\s\S]*$/i, '')
    .trim();

export const stripSourceAppendix = t => t
    .replace(/\n\n(?:Sources?|References?|APA References?|Works Cited|Following instructions?|The following sources)[\s\S]*$/i, '')
    .replace(/\n\nFollowing instructions[\s\S]*$/i, '')
    .trim();

export const stripExistingCitations = t => t
    .replace(/\([A-Z][a-zA-Z\s,&.]+(?:et al\.)?[,\s]+\d{4}[a-z]?\)/g, '')
    .replace(/\b([A-Z][a-z]+(?:\s+(?:et al\.|&\s+[A-Z][a-z]+))?)\s*\(\d{4}[a-z]?\)/g, '$1')
    .replace(/\(\d{4}[a-z]?\)/g, '')
    .replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

// ─── Sentence splitter ────────────────────────────────────────────────────────
const ABBREV_RE = /(?:et al|Dr|Mr|Mrs|Ms|Prof|Sr|Jr|vs|e\.g|i\.e|cf|viz|fig|ibid|ca|pp|Vol|No|ed|eds|trans|rev|para|chap|pt)\s*$/i;
const INITIAL_RE = /\b[A-Z]\.$/;

export const splitSentences = text => {
    const raw = [];
    let current = '';
    let i = 0;

    while (i < text.length) {
        current += text[i];

        if (/[.!?]/.test(text[i])) {
            let j = i + 1;
            while (j < text.length && /[\s"')»\u00B9\u00B2\u00B3\u2074-\u2079\u2070]/.test(text[j])) {
                current += text[j];
                j++;
            }

            const ahead = text.slice(j, j + 2);
            const isEnd = j >= text.length || /^[A-Z"']/.test(ahead) || /^\n/.test(ahead);
            const precedingWord = current.replace(/[.!?\s"')»]+$/, '').split(/\s+/).pop() || '';
            const isAbbrev = ABBREV_RE.test(precedingWord) || INITIAL_RE.test(precedingWord);

            if (isEnd && !isAbbrev) {
                raw.push(current.trim());
                current = '';
                i = j;
                continue;
            }
        }
        i++;
    }
    if (current.trim()) raw.push(current.trim());
    return raw.filter(s => s.length > 0);
};

// ─── Header repair ───────────────────────────────────────────────────────────
const KNOWN_HEADERS = [
    'ARGUMENTS FOR (EMBRACE):',
    'ARGUMENTS AGAINST (PANIC):',
    'DECISION:',
    'JUSTIFICATION:'
];

export const ensureHeaders = t => {
    let result = t;
    for (const hdr of KNOWN_HEADERS) {
        const escaped = hdr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`(?<!^)(?<!\\n)\\s*${escaped}`, 'gm'), `\n\n${hdr}`);
    }
    result = result.replace(/([.!?])\s+((?:[A-Z][A-Z\s\(\)\/\-&]{2,}):?\s*$)/gm, '$1\n\n$2');
    return result.replace(/\n{3,}/g, '\n\n').trim();
};

// ─── Combined cleaner used after every WRITE/CITE/QUOTES pass ───────────────
export const cleanText = text =>
    ensureHeaders(stripBecauseStarts(stripHollowFiller(stripPreamble(stripMarkdown(stripRefs(stripSourceAppendix(text)))))));

// ─── Topic extraction ─────────────────────────────────────────────────────────
export const extractTopic = text => {
    const m = text.match(/(?:issue:|about|essay on|write about)[:\s]+["']?([^"'\n.!?]{10,80})/i);
    if (m) return m[1].trim();
    const skip = new Set([
        'write', 'essay', 'paragraph', 'summary', 'discuss', 'explain', 'please', 'about',
        'using', 'citations', 'should', 'issue', 'sample', 'table', 'arguments', 'decision',
        'panic', 'embrace', 'research', 'reliable', 'sources', 'consider', 'sides', 'based',
        'scientific', 'knowledge', 'following', 'justify', 'required', 'references', 'apa',
        'watch', 'video', 'organize', 'after', 'weighed', 'state', 'feel', 'free', 'record',
        'voice', 'response', 'instead', 'expectation', 'evaluate', 'basis', 'limited', 'thought'
    ]);
    return (text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [])
        .filter(w => !skip.has(w))
        .slice(0, 6)
        .join(' ') || text.substring(0, 80);
};

// ─── Task format detection ────────────────────────────────────────────────────
export const detectTaskFormat = userTask => {
    if (/arguments?\s+for|arguments?\s+against|for\s*\(embrace\)|against\s*\(panic\)/i.test(userTask)) return 'table';
    if (/(?:^|\n)\s*(?:step\s*\d+|\d+[\.\)]|[•\-]\s+\w)/im.test(userTask) && !/essay/i.test(userTask)) return 'steps';
    if (/\?\s*$|\?\s*\n|(?:^|\n)\s*(?:a\)|b\)|1\.|2\.)|\banswer\b|\brespond to\b/im.test(userTask)) return 'questions';
    if (/\b(?:list|bullet|enumerate|outline)\b/i.test(userTask) && !/essay/i.test(userTask)) return 'list';
    if (/\b(?:paragraph|short answer|in one sentence|in a sentence|briefly explain|brief explanation|brief response|short paragraph)\b/i.test(userTask) && !/essay/i.test(userTask)) return 'paragraph';
    if (/\b(?:essay|argue|argument|thesis|discuss at length)\b/i.test(userTask)) return 'essay';
    if (/\bexpectation\b|\brubric\b|\bL1\b|\bL2\b|\bL3\b|\bL4\b/i.test(userTask)) return 'structured';
    return 'general';
};
