
// api/features/agent.js
import { GeminiAPI } from '../utils/geminiAPI.js';
import { GroqAPI } from '../utils/groqAPI.js';
import { SourceFinderAPI } from '../utils/sourceFinder.js';
import humanizerHandler from './humanizer.js';
import graderHandler from './grader.js';

// ─── Text cleanup helpers ────────────────────────────────────────────────────

const stripMarkdown = t => t
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/`([^`]+)`/g, '$1');

const stripPreamble = t => t
    .replace(/^(?:(?:Here(?:'s| is)|Sure[,!]?\s*(?:here(?:'s| is))?|Okay[,!]?\s*(?:here(?:'s| is))?|Certainly[,!]?\s*(?:here(?:'s| is))?|I'(?:ve|ll)|Below is|The following is)[^\n]*\n)+/i, '')
    .trim();

// ─── Pre-strip "Because" starts — deterministic, no AI needed ────────────────
const stripBecauseStarts = text => text
    .replace(/^(\s*[-•]\s+)Because\s+([a-z])/gm, (_, prefix, c) => prefix + c.toUpperCase())
    .replace(/^Because\s+([a-z])/gm, (_, c) => c.toUpperCase())
    .replace(/([.!?]\s+)Because\s+([a-z])/g, (_, punct, c) => punct + c.toUpperCase());

// ─── Strip hollow filler sentences ───────────────────────────────────────────
// Removes sentences that make a vague observation without specific content
const stripHollowFiller = text => text
    // "The potential for X is undeniable/significant/clear, but Y"
    .replace(/\s*The potential for [^.!?]+ is (?:undeniable|significant|clear|substantial|tremendous)[^.!?]*\./gi, '')
    // "The prospect of X raises serious concerns about Y" with no follow-through
    .replace(/\s*The prospect of [^.!?]+ raises serious concerns[^.!?]*\./gi, '')
    // "X is not without risk/challenge/issue" — vague caveat sentences
    .replace(/\s*(?:the )?(?:process|approach|technology|method) is not without (?:risk|challenge|issue|concern)[^.!?]*\./gi, '')
    // Orphan mid-thought connectors like "When X, it paves the way for Y" that restate previous sentence
    .replace(/\s*When (?:researchers?|scientists?|we) (?:gain|develop|uncover|discover)[^.!?]+(?:paves the way for|opens doors to|enables)[^.!?]*\./gi, '')
    .replace(/  +/g, ' ').replace(/ +\n/g, '\n').trim();

// ─── Sentence splitter ────────────────────────────────────────────────────────
const ABBREV_RE = /(?:et al|Dr|Mr|Mrs|Ms|Prof|Sr|Jr|vs|e\.g|i\.e|cf|viz|fig|ibid|ca|pp|Vol|No|ed|eds|trans|rev|para|chap|pt)\s*$/i;
const INITIAL_RE = /\b[A-Z]\.$/;

const splitSentences = text => {
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

const ensureHeaders = t => {
    let result = t;
    for (const hdr of KNOWN_HEADERS) {
        const escaped = hdr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`(?<!^)(?<!\\n)\\s*${escaped}`, 'gm'), `\n\n${hdr}`);
    }
    result = result.replace(/([.!?])\s+((?:[A-Z][A-Z\s\(\)\/\-&]{2,}):?\s*$)/gm, '$1\n\n$2');
    return result.replace(/\n{3,}/g, '\n\n').trim();
};

// ─── Groq QA check ───────────────────────────────────────────────────────────
const checkWithGroq = async (text, taskFmt, GROQ) => {
    if (!GROQ || !text) return { pass: true };
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
        console.error('[Agent] Groq check failed:', e.message);
        return { pass: true };
    }
};

const applyFixes = (text, checks) => {
    let result = text;

    // Always run deterministic strips first
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

const stripRefs = t => t
    .replace(/\n\n\*?\*?(?:APA References?|References?|Works Cited|Bibliography|Notes)[:\s]*\*?\*?[\s\S]*$/i, '')
    .trim();

const stripSourceAppendix = t => t
    .replace(/\n\n(?:Sources?|References?|APA References?|Works Cited|Following instructions?|The following sources)[\s\S]*$/i, '')
    .replace(/\n\nFollowing instructions[\s\S]*$/i, '')
    .trim();

const stripExistingCitations = t => t
    .replace(/\([A-Z][a-zA-Z\s,&.]+(?:et al\.)?[,\s]+\d{4}[a-z]?\)/g, '')
    .replace(/\b([A-Z][a-z]+(?:\s+(?:et al\.|&\s+[A-Z][a-z]+))?)\s*\(\d{4}[a-z]?\)/g, '$1')
    .replace(/\(\d{4}[a-z]?\)/g, '')
    .replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

// ─── Topic extraction ─────────────────────────────────────────────────────────

const extractTopic = text => {
    const m = text.match(/(?:issue:|about|essay on|write about)[:\s]+["']?([^"'\n.!?]{10,80})/i);
    if (m) return m[1].trim();
    const skip = new Set([
        'write','essay','paragraph','summary','discuss','explain','please','about',
        'using','citations','should','issue','sample','table','arguments','decision',
        'panic','embrace','research','reliable','sources','consider','sides','based',
        'scientific','knowledge','following','justify','required','references','apa',
        'watch','video','organize','after','weighed','state','feel','free','record',
        'voice','response','instead','expectation','evaluate','basis','limited','thought'
    ]);
    return (text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [])
        .filter(w => !skip.has(w))
        .slice(0, 6)
        .join(' ') || text.substring(0, 80);
};

// ─── Author formatting ────────────────────────────────────────────────────────

const fmtAuthorLastOnly = (s, style = 'apa') => {
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

// ─── Task format detection ────────────────────────────────────────────────────

const detectTaskFormat = userTask => {
    if (/arguments?\s+for|arguments?\s+against|for\s*\(embrace\)|against\s*\(panic\)/i.test(userTask)) return 'table';
    if (/(?:^|\n)\s*(?:step\s*\d+|\d+[\.\)]|[•\-]\s+\w)/im.test(userTask) && !/essay/i.test(userTask)) return 'steps';
    if (/\?\s*$|\?\s*\n|(?:^|\n)\s*(?:a\)|b\)|1\.|2\.)|\banswer\b|\brespond to\b/im.test(userTask)) return 'questions';
    if (/\b(?:list|bullet|enumerate|outline)\b/i.test(userTask) && !/essay/i.test(userTask)) return 'list';
    if (/\b(?:paragraph|short answer|in one sentence|in a sentence|briefly explain|brief explanation|brief response|short paragraph)\b/i.test(userTask) && !/essay/i.test(userTask)) return 'paragraph';
    if (/\b(?:essay|argue|argument|thesis|discuss at length)\b/i.test(userTask)) return 'essay';
    if (/\bexpectation\b|\brubric\b|\bL1\b|\bL2\b|\bL3\b|\bL4\b/i.test(userTask)) return 'structured';
    return 'general';
};

// ─── HTML builders ─────────────────────────────────────────────────────────────

const renderEntry = (plainCitation, source) => {
    if (!plainCitation) return '';
    const journal = source.venue || '';
    const doiUrl = source.doi ? `https://doi.org/${source.doi}` : '';
    let text = plainCitation;
    if (journal) {
        const ej = journal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`(${ej})`), '\x00I\x00$1\x00/I\x00');
    }
    if (doiUrl) {
        const eu = doiUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(eu), `\x00A\x00${doiUrl}\x00/A\x00`);
    }
    text = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return text
        .replace(/\x00I\x00/g,'<i>').replace(/\x00\/I\x00/g,'</i>')
        .replace(/\x00A\x00/g,`<a href="${doiUrl}" target="_blank">`)
        .replace(/\x00\/A\x00/g,'</a>');
};

const buildBibliographyHTML = (sources, style, type, insertionOrder = null) => {
    if (!sources?.length) return { html: '', plain: '' };
    const isApa = style.includes('apa');
    const isMla = style.includes('mla');
    const isFootnotes = type === 'footnotes';
    const title = isFootnotes ? 'Notes' : isMla ? 'Works Cited' : isApa ? 'References' : 'Bibliography';

    const sorted = isFootnotes
        ? (insertionOrder || sources)
        : [...sources].sort((a, b) => {
            const ka = (a.authors?.[0]?.family || a.author || 'zzz').toLowerCase();
            const kb = (b.authors?.[0]?.family || b.author || 'zzz').toLowerCase();
            return ka.localeCompare(kb);
        });

    const wrapStyle = `font-family:'Times New Roman',Times,serif;font-size:12pt;line-height:2;color:#000;background:#fff;padding:20px;`;
    const titleStyle = `text-align:center;margin-bottom:24px;font-weight:normal;font-family:'Times New Roman',Times,serif;font-size:12pt;`;
    const entryStyle = `text-indent:-36px;padding-left:36px;margin:0 0 24px 0;line-height:2;font-family:'Times New Roman',Times,serif;font-size:12pt;color:#000;`;

    let html = `<div class="bibliography" style="${wrapStyle}"><p style="${titleStyle}">${title}</p>`;
    let plain = `${title}\n\n`;

    sorted.forEach((s, i) => {
        const citationPlain = s.citation || `${s.author||'Unknown'} (${s.year||'n.d.'}). ${s.title||'Untitled'}.`;
        const citationHtml = renderEntry(citationPlain, s);
        if (isFootnotes) {
            html += `<p style="${entryStyle}">${i+1}. ${citationHtml}</p>`;
            plain += `${i+1}. ${citationPlain}\n\n`;
        } else {
            html += `<p style="${entryStyle}">${citationHtml}</p>`;
            plain += `${citationPlain}\n\n`;
        }
    });

    html += `</div>`;
    return { html, plain };
};

const buildEssayHTML = text => {
    if (!text) return '<i>No output.</i>';
    const base = `font-family:'Times New Roman',Times,serif;font-size:12pt;line-height:2;color:#000;`;
    const hasHtml = /<[a-z][\s\S]*>/i.test(text);
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const isHeader = s => /^[A-Z][A-Z\s\(\)\/\-&]{2,}:?\s*$/.test(s.trim()) && s.trim().length < 80;
    const isBullet = s => /^\s*[-•]\s+/.test(s);

    const renderBlock = block => {
        const lines = block.split(/\n/);
        if (lines.length === 1 && isHeader(lines[0])) {
            const content = hasHtml ? lines[0] : esc(lines[0]);
            return `<p style="margin:20px 0 4px 0;font-weight:bold;text-indent:0;">${content}</p>`;
        }
        if (lines.every(l => !l.trim() || isBullet(l))) {
            return lines.filter(l => l.trim()).map(l => {
                const content = hasHtml ? l : esc(l);
                return `<p style="margin:0;text-indent:0;padding-left:24px;">${content}</p>`;
            }).join('\n');
        }
        if (isHeader(lines[0]) && lines.length > 1) {
            const header = hasHtml ? lines[0] : esc(lines[0]);
            const rest = lines.slice(1).join('\n');
            const content = hasHtml ? rest : esc(rest);
            return `<p style="margin:20px 0 4px 0;font-weight:bold;text-indent:0;">${header}</p>` +
                   `<p style="margin:0;text-indent:36px;">${content.replace(/\n/g,'<br>')}</p>`;
        }
        const content = hasHtml ? block.replace(/\n/g,'<br>') : esc(block).replace(/\n/g,'<br>');
        return `<p style="margin:0;text-indent:36px;">${content}</p>`;
    };

    return `<div style="${base}">` +
        text.split(/\n\n+/).map(renderBlock).join('\n') +
        `</div>`;
};

// ─── Source digest ────────────────────────────────────────────────────────────
const buildSourceDigest = async (sources, style, GEMINI) => {
    const isApa = style.includes('apa');
    const isMla = style.includes('mla');
    const digest = {};

    const subset = sources.slice(0, 8);

    // Pre-compute inTextKeys and quotes deterministically (no AI needed)
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

    // Single batched Gemini call instead of one per source
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
        console.error('[Agent] Digest batch failed:', e.message);
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

// ─── JSON insertion — appends citation inside sentence's final punctuation ────
const applyInsertions = (sentences, insertionMap) => {
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

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { action, task, options = {} } = req.body;
        const GEMINI = process.env.GEMINI_API_KEY;
        const GROQ = process.env.GROQ_API_KEY;

        // ── PLAN ──────────────────────────────────────────────────────────────
        if (action === 'plan') {
            const fast = options.fastMode === true;
            const steps = [{ tool: 'RESEARCH', action: 'Find academic sources' }];
            if (options.enableWrite !== false) steps.push({ tool: 'WRITE', action: 'Write response' });
            // Fast mode: skip humanize, quotes, and QA — cuts 2–3 API calls
            if (!fast && options.enableHumanize) steps.push({ tool: 'HUMANIZE', action: 'Humanize text' });
            if (options.enableCite) steps.push({ tool: 'CITE', action: `Add ${options.citationType || 'in-text'} citations` });
            if (!fast && options.enableQuotes) steps.push({ tool: 'QUOTES', action: 'Insert quotes with transitions' });
            if (options.enableGrade) steps.push({ tool: 'GRADE', action: 'Grade work' });
            return res.status(200).json({ success: true, plan: { steps } });
        }

        // ── EXECUTE STEP ──────────────────────────────────────────────────────
        if (action === 'execute_step') {
            const { step, context = {}, options = {} } = req.body;
            const result = { success: true, output: '', type: 'text' };

            switch (step.tool.toUpperCase()) {

                // ── RESEARCH ─────────────────────────────────────────────────
                case 'RESEARCH': {
                    const topic = extractTopic(context.task || '');
                    const style = options.citationStyle || 'apa7';
                    console.log('[Agent] Research topic:', topic, 'Style:', style);

                    const papers = await SourceFinderAPI.searchTopic(topic, 12, style);
                    if (!papers?.length) { result.output = { sources: [] }; result.type = 'research'; break; }

                    const sources = papers.map(p => ({
                        id: p.id,
                        title: p.title, url: p.url, doi: p.doi,
                        venue: p.venue, author: p.author, authors: p.authors || [],
                        year: p.year, displayName: p.author || p.displayName,
                        text: p.abstract || p.text,
                        citation: p.citation || SourceFinderAPI._formatCitation(p, style),
                        citationSource: p.citationSource || 'generated',
                        volume: p.volume || null, issue: p.issue || null, pages: p.pages || null
                    }));

                    console.log('[Agent] RESEARCH:', sources.filter(s=>s.citationSource==='crossref').length, '/', sources.length, 'Crossref');
                    result.output = { sources };
                    result.type = 'research';
                    break;
                }

                // ── WRITE ─────────────────────────────────────────────────────
                case 'WRITE': {
                    const { researchSources = [], task: userTask, uploadedFile, uploadedFiles = [] } = context;

                    const allFiles = uploadedFiles.length > 0 ? uploadedFiles : (uploadedFile ? [uploadedFile] : []);
                    const imageFiles = allFiles.filter(f => f.type?.startsWith('image/'));
                    const pdfFiles = allFiles.filter(f => f.type === 'application/pdf');
                    const otherFiles = allFiles.filter(f => !f.type?.startsWith('image/') && f.type !== 'application/pdf');

                    const taskTopic = extractTopic(userTask);
                    let pdfContext = '';
                    for (const pdf of pdfFiles) {
                        try {
                            const pdfText = await GeminiAPI.vision(`Extract ONLY information relevant to: "${taskTopic}". Summarize key findings, arguments, and data. Skip unrelated sections.`, GEMINI, [pdf]);
                            pdfContext += `\nUPLOADED DOCUMENT (${pdf.name}):\n${pdfText}\n`;
                        } catch(e) { console.error('[Agent] PDF extraction failed:', e.message); }
                    }
                    const fileContext = otherFiles.length > 0
                        ? `\nUSER FILES: ${otherFiles.map(f=>f.name).join(', ')} - consider this context.\n` : '';

                    const sourceInfo = researchSources.slice(0, 5).map((s, i) =>
                        `SOURCE ${i+1} [Key: ${fmtAuthorLastOnly(s)}, ${s.year}]:\nTitle: "${s.title}"\nSummary: ${(s.text||'').substring(0, 120)||'N/A'}`
                    ).join('\n\n');

                    const fmt = detectTaskFormat(userTask);
                    let formatInstructions = '';

                    if (fmt === 'table') {
                        formatInstructions = `FORMAT — STRUCTURED TABLE ASSIGNMENT. Output EXACTLY these four sections with their headers on their own lines.

ARGUMENTS FOR (EMBRACE):
- [Argument 1: EXACTLY 2-3 sentences. S1: state the specific claim. S2: explain the mechanism or consequence — WHY does this matter? S3 (optional): concrete real-world example.]
- [Argument 2: different angle, same structure]
- [Argument 3: different angle, same structure]
- [Argument 4: different angle, same structure]

ARGUMENTS AGAINST (PANIC):
- [Argument 1: same structure as above]
- [Argument 2: different angle]
- [Argument 3: different angle]
- [Argument 4: different angle]

DECISION:
Exactly ONE sentence. State your position and the single most decisive reason. No quotes. No restatement.

JUSTIFICATION:
Exactly 4 paragraphs. Each paragraph covers a DISTINCT dimension (e.g. biological, economic, ethical, ecological — do not repeat the same dimension).

Each paragraph structure:
  S1: Specific claim relevant to your decision.
  S2–S3: Mechanism — WHY does this matter? What specific consequence does it lead to? Name it concretely.
  S4: Engage the strongest counterargument to this point in one sentence (e.g. "Proponents argue that regulation could prevent this..."), then refute it in S5 with a specific reason it falls short.

SOURCE DIVERSITY RULE — STRICTLY ENFORCED:
- Do NOT cite the same source in more than 2 consecutive sentences.
- Each paragraph must draw on at least 2 different ideas (they don't need to be from different sources, but the ideas must be distinct).
- If you find yourself citing the same author repeatedly in a row, switch to a different angle or piece of evidence first.

"SO WHAT?" RULE — STRICTLY ENFORCED:
After every claim, the next sentence must name a SPECIFIC consequence.
BAD: "This highlights the importance of caution."
GOOD: "A single off-target mutation in the embryo propagates into every cell of every descendant, making reversal biologically impossible."

SPECIFICITY RULE:
When claiming a risk or benefit, include at least one concrete anchor:
- A named condition, disease, or biological process (e.g. sickle cell anemia, off-target indels)
- A real-world precedent or analogy (e.g. thalidomide, monoculture crop failures)
- A measurable or observable outcome (e.g. "increases edit precision to 99% but still leaves a 1% error rate across billions of base pairs")

SENTENCE STARTER RULES:
- NEVER start any sentence or bullet with "Because"
- NEVER start two consecutive sentences with the same word

FILLER RULE:
These sentence patterns are FORBIDDEN — delete them if you write them:
- "The potential for X is undeniable"
- "X is not without risk"
- "The prospect of X raises concerns"
- "When researchers gain X, it paves the way for Y" (restating the previous sentence)
- Any sentence that makes a vague observation without naming a specific consequence

CRITICAL: All four headers (ARGUMENTS FOR (EMBRACE):, ARGUMENTS AGAINST (PANIC):, DECISION:, JUSTIFICATION:) MUST appear verbatim on their own lines.`;

                    } else if (fmt === 'steps' || fmt === 'structured') {
                        formatInstructions = `FORMAT — STRUCTURED ASSIGNMENT:
- Read the task carefully and identify each distinct section or deliverable
- Complete each section fully, in the order given
- Use the exact section labels from the task
- Do NOT convert this into a prose essay
- Plain text, no markdown formatting`;

                    } else if (fmt === 'questions') {
                        formatInstructions = `FORMAT — ANSWER EACH QUESTION:
- Answer each question directly and completely, keeping original numbering
- Plain text only — no markdown`;

                    } else if (fmt === 'list') {
                        formatInstructions = `FORMAT — LIST:
- Clear, organized structure
- Plain text only — no markdown`;

                    } else if (fmt === 'paragraph') {
                        formatInstructions = `FORMAT — PARAGRAPH RESPONSE:
- Write a single well-developed paragraph (or the number specified)
- Do NOT expand into a multi-section essay
- Plain text only — no markdown`;

                    } else if (fmt === 'essay') {
                        formatInstructions = `FORMAT — ACADEMIC ESSAY:
- Introduction with explicit thesis in final sentence
- Body paragraphs: one main point each; after every claim, name the specific consequence ("So what?")
- At least one paragraph must engage a counterargument and refute it with specific reasoning
- No two paragraphs may cover the same dimension
- Conclusion: synthesize, don't summarize
- Vary sentence openings; formal academic tone throughout`;

                    } else {
                        formatInstructions = `FORMAT — MATCH THE TASK EXACTLY:
- Identify what format the task asks for and produce ONLY that
- NEVER write a multi-section essay unless the task uses the word "essay"
- Do NOT add titles, headers, or sections the task did not ask for
- Plain text — no markdown`;
                    }

                    const prompt = `Complete the following task accurately.

TASK:
${userTask}
${pdfContext}${fileContext}
${researchSources.length > 0 ? `\nRESEARCH SOURCES (use for ideas and content only — do NOT include citations, author names, or references in your output now):\n${sourceInfo}` : ''}

${formatInstructions}

CRITICAL RULES — ALWAYS APPLY:
- Do NOT include any in-text citations, author names, or source references anywhere in the output
- Do NOT add a reference list, "Sources:", or bibliography section at the end
- Do NOT mention specific researchers, papers, or organisations by name
- Do NOT start with any preamble — begin with the actual content immediately
- Do NOT use direct quotes from sources — paraphrase all source material
- NEVER start a sentence with "Because" — lead with the subject or claim instead
- NEVER write a vague sentence that makes an observation without naming a specific consequence
${imageFiles.length > 0 ? '- Carefully analyze any uploaded images as part of the response.' : ''}

Complete the task now:`;

                    const rawText = imageFiles.length > 0
                        ? await GeminiAPI.vision(prompt, GEMINI, imageFiles)
                        : await GeminiAPI.chat(prompt, GEMINI);

                    // Deterministic fixes applied now; QA deferred to CITE/QUOTES step to save an API call
                    let plainText = stripBecauseStarts(stripHollowFiller(ensureHeaders(stripPreamble(stripMarkdown(stripRefs(stripSourceAppendix(rawText)))))));
                    result.output = plainText;
                    result.outputHtml = buildEssayHTML(plainText);
                    result.type = 'text';
                    break;
                }

                // ── HUMANIZE ──────────────────────────────────────────────────
                case 'HUMANIZE': {
                    const input = context.previousOutput || '';
                    if (!input) { result.output = ''; result.outputHtml = ''; break; }

                    const runHumanizer = async text => {
                        if (!text.trim()) return text;
                        let out = '';
                        const mockReq = { method: 'POST', body: { text } };
                        const mockRes = { setHeader:()=>{}, status:()=>({ end:()=>{}, json:d=>{ out=d; } }) };
                        await humanizerHandler(mockReq, mockRes);
                        return (out.success && out.result) ? out.result : text;
                    };

                    const isHdr = s => /^[A-Z][A-Z\s\(\)\/\-&]{2,}:?\s*$/.test(s.trim()) && s.trim().length < 80;
                    const inputLines = input.split('\n');
                    const sections = [];
                    let cur = null;
                    for (const line of inputLines) {
                        if (isHdr(line)) {
                            if (cur) sections.push(cur);
                            cur = { header: line.trim(), lines: [] };
                        } else {
                            if (!cur) cur = { header: '', lines: [] };
                            cur.lines.push(line);
                        }
                    }
                    if (cur) sections.push(cur);

                    const humanizedSections = await Promise.all(sections.map(async section => {
                        const bodyText = section.lines.join('\n').trim();
                        if (!bodyText) return section.header;

                        const bodyLines = section.lines.filter(l => l.trim());
                        const isBulletSection = bodyLines.length > 0 && bodyLines.every(l => /^\s*[-•]\s+/.test(l));

                        let humanizedBody;
                        if (isBulletSection) {
                            // Batch all bullets into one call then split back — avoids N separate API calls
                            const combined = bodyLines
                                .map(l => l.replace(/^\s*[-•]\s+/, ''))
                                .join('\n');
                            const humanizedCombined = await runHumanizer(combined);
                            const splitBack = humanizedCombined.split('\n');
                            humanizedBody = splitBack
                                .map(l => `- ${l.trim()}`)
                                .filter(l => l.length > 2)
                                .join('\n');
                        } else {
                            humanizedBody = await runHumanizer(bodyText);
                        }

                        return section.header ? `${section.header}\n${humanizedBody}` : humanizedBody;
                    }));

                    const humanized = humanizedSections.join('\n\n');
                    result.output = humanized;
                    result.outputHtml = buildEssayHTML(humanized);
                    result.type = 'text';
                    break;
                }

                // ── CITE ──────────────────────────────────────────────────────
                case 'CITE': {
                    const sources = context.researchSources || [];
                    const style = options.citationStyle || 'apa7';
                    const type = (options.citationType || 'in-text').toLowerCase().trim();
                    const isBibliographyOnly = type === 'bibliography';
                    const isFootnotes = type === 'footnotes';
                    const isApa = style.includes('apa');
                    const isMla = style.includes('mla');

                    const rawInput = (context.previousOutput || '').trim() || (context.task || '').trim();
                    const input = stripExistingCitations(stripSourceAppendix(stripRefs(rawInput)));

                    const sourcesWithCitations = sources.map(s => ({
                        ...s,
                        citation: s.citation || SourceFinderAPI._formatCitation(s, style)
                    }));

                    const finish = (essayText, citedSources, insertionOrder = null) => {
                        const bib = buildBibliographyHTML(
                            citedSources, style,
                            isFootnotes ? 'footnotes' : 'bibliography',
                            insertionOrder
                        );
                        result.output = essayText;
                        result.outputHtml = buildEssayHTML(essayText);
                        result.citedSources = citedSources;
                        result.bibliographyHtml = bib.html;
                        result.bibliographyPlain = bib.plain;
                        result.type = 'cited';
                    };

                    if (!sourcesWithCitations.length) { finish(input, []); break; }
                    if (!input) { finish('', sourcesWithCitations); break; }

                    // ── BIBLIOGRAPHY ONLY ─────────────────────────────────────
                    if (isBibliographyOnly) {
                        finish(input, sourcesWithCitations);
                        break;
                    }

                    // ── IN-TEXT or FOOTNOTES ──────────────────────────────────
                    const digest = await buildSourceDigest(sourcesWithCitations, style, GEMINI);
                    result.sourceDigest = digest; // cache for reuse in QUOTES step
                    const sentences = splitSentences(input);

                    const sourceList = sourcesWithCitations.slice(0, 12).map((s, i) => {
                        const key = s.url || s.doi || s.id || s.title;
                        const d = digest[key] || {};
                        const lastName = fmtAuthorLastOnly(s, isMla ? 'mla' : 'apa');
                        const inTextKey = isApa
                            ? `(${lastName}, ${s.year})`
                            : isMla ? `(${lastName})` : `(${lastName} ${s.year})`;
                        return `[${i}] CITE-AS: ${inTextKey}\n    Main idea: ${d.mainIdea || (s.text||'').substring(0,150)}\n    Title: "${s.title}"`;
                    }).join('\n\n');

                    const numberedSentences = sentences
                        .slice(0, 25) // limit token cost for long essays
                        .map((s, i) => `[${i}] ${s.trim()}`)
                        .join('\n');

                    if (!isFootnotes) {
                        // ── IN-TEXT ───────────────────────────────────────────
                        // If QUOTES step follows, merge both into this single call
                        const availableQuotes = [];
                        for (const [, d] of Object.entries(digest)) {
                            for (const q of d.quotes) {
                                if (q.length > 40) availableQuotes.push({ quote: q, inTextKey: d.inTextKey, mainIdea: d.mainIdea });
                            }
                        }
                        const mergeQuotes = options.enableQuotes && availableQuotes.length > 0;
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

                        try {
                            const raw = await GeminiAPI.chat(citePrompt, GEMINI, 0.3);
                            const jsonMatch = raw.match(/\{[\s\S]*\}/);
                            if (jsonMatch) {
                                const json = JSON.parse(jsonMatch[0]);
                                const citationMap = mergeQuotes ? (json.citations || {}) : json;
                                const quoteMap = mergeQuotes ? (json.quotes || {}) : {};

                                // Apply citations
                                const cited = applyInsertions(sentences, citationMap);

                                // Apply quotes (inserted after specified sentence indices)
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

                                const citedClean = ensureHeaders(stripBecauseStarts(stripHollowFiller(stripPreamble(stripMarkdown(stripRefs(stripSourceAppendix(finalText)))))));

                                if (mergeQuotes) result.quotesHandledInCite = true;

                                // Run QA here only when QUOTES won't run (avoids double QA call)
                                if (!mergeQuotes && !options.enableQuotes && GROQ && citedClean.length > 1000) {
                                    const checks = await checkWithGroq(citedClean, detectTaskFormat(context.task || ''), GROQ);
                                    finish(applyFixes(citedClean, checks), sourcesWithCitations);
                                } else {
                                    finish(citedClean, sourcesWithCitations);
                                }
                                break;
                            }
                        } catch(e) {
                            console.error('[Agent] CITE in-text JSON parse failed:', e.message);
                        }
                        finish(input, sourcesWithCitations);
                        break;
                    }

                    // ── FOOTNOTES ─────────────────────────────────────────────
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

                    try {
                        const raw = await GeminiAPI.chat(footnotePrompt, GEMINI, 0.3);
                        const jsonMatch = raw.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const insertionMap = JSON.parse(jsonMatch[0]);
                            const superToNum = {'¹':1,'²':2,'³':3,'⁴':4,'⁵':5,'⁶':6,'⁷':7,'⁸':8,'⁹':9,'⁰':0};
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
                            finish(ensureHeaders(cited), sourcesWithCitations, noteOrder.length ? noteOrder : null);
                            break;
                        }
                    } catch(e) {
                        console.error('[Agent] CITE footnotes JSON parse failed:', e.message);
                    }
                    finish(input, sourcesWithCitations);
                    break;
                }

                // ── QUOTES ────────────────────────────────────────────────────
                case 'QUOTES': {
                    const input = context.previousOutput || '';
                    const sources = context.researchSources || [];
                    const taskFmt = detectTaskFormat(context.task || '');

                    const runFinalQA = async text => {
                        if (!GROQ || text.length < 1000) return text;
                        try {
                            const checks = await checkWithGroq(text, taskFmt, GROQ);
                            return applyFixes(text, checks);
                        } catch (e) { return text; }
                    };

                    if (!input || !sources.length) { result.output=input; result.outputHtml=buildEssayHTML(input); result.type='text'; break; }

                    // Quotes were already merged into CITE — just run final QA and exit
                    if (context.quotesHandledInCite) {
                        const cleaned = await runFinalQA(stripBecauseStarts(stripHollowFiller(input)));
                        result.output = cleaned;
                        result.outputHtml = buildEssayHTML(cleaned);
                        result.type = 'text';
                        break;
                    }

                    // Skip quote insertion if task doesn't call for them — still run QA
                    if (!/quote|evidence|support|direct quote/i.test(context.task || '')) {
                        const cleaned = await runFinalQA(input);
                        result.output = cleaned;
                        result.outputHtml = buildEssayHTML(cleaned);
                        result.type = 'text';
                        break;
                    }

                    const style = options.citationStyle || 'apa7';
                    // Reuse digest built by CITE step if available
                    const digest = context.sourceDigest || await buildSourceDigest(sources, style, GEMINI);

                    const availableQuotes = [];
                    for (const [, d] of Object.entries(digest)) {
                        for (const quote of d.quotes) {
                            if (quote.length > 40) {
                                availableQuotes.push({ quote, inTextKey: d.inTextKey, mainIdea: d.mainIdea });
                            }
                        }
                    }

                    if (!availableQuotes.length) {
                        const cleaned = await runFinalQA(input);
                        result.output = cleaned;
                        result.outputHtml = buildEssayHTML(cleaned);
                        result.type = 'text';
                        break;
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

                    let withQuotes = input;
                    try {
                        const raw = await GeminiAPI.chat(quotesPrompt, GEMINI, 0.4);
                        const jsonMatch = raw.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const insertionMap = JSON.parse(jsonMatch[0]);
                            const resultSentences = [];
                            sentences.forEach((sentence, idx) => {
                                resultSentences.push(sentence);
                                const key = String(idx);
                                if (insertionMap[key]) resultSentences.push(insertionMap[key]);
                            });
                            withQuotes = resultSentences.join(' ');
                        }
                    } catch(e) {
                        console.error('[Agent] QUOTES JSON parse failed:', e.message);
                    }

                    withQuotes = stripBecauseStarts(stripHollowFiller(ensureHeaders(stripPreamble(stripMarkdown(withQuotes)))));
                    // Single QA pass — final text step
                    withQuotes = await runFinalQA(withQuotes);
                    result.output = withQuotes;
                    result.outputHtml = buildEssayHTML(withQuotes);
                    result.type = 'text';
                    break;
                }

                // ── GRADE ──────────────────────────────────────────────────────
                case 'GRADE': {
                    const text = context.previousOutput || '';
                    if (!text) { result.output={grade:'N/A',feedback:'No text to grade.'}; result.type='grade'; break; }

                    const citedSources = context.researchSources || [];
                    let fullSubmission = text;
                    if (citedSources.length && options.enableCite) {
                        const bibStyle = options.citationStyle || 'apa7';
                        const bibType = options.citationType || 'in-text';
                        const bib = buildBibliographyHTML(citedSources, bibStyle, bibType === 'footnotes' ? 'footnotes' : 'bibliography');
                        if (bib.plain) fullSubmission = text + '\n\n' + bib.plain;
                    }

                    const mockReq = {
                        method: 'POST',
                        body: {
                            text: fullSubmission,
                            instructions: context.task || '',
                            rubric: context.rubric || '',
                            files: (context.uploadedFiles||[]).map(f=>({name:f.name,type:f.type,content:f.data,isBase64:true}))
                        }
                    };
                    let gradeResult = null;
                    const mockRes = { setHeader:()=>{}, status:()=>({ end:()=>{}, json:d=>{ gradeResult=d; } }) };
                    await graderHandler(mockReq, mockRes);

                    const feedback = gradeResult?.result || 'Grading completed.';
                    const gradeMatch = feedback.match(/(?:Overall\s+)?Grade[:\s]*([A-F][+-]?|\d+[\/.]\d+)/i)
                        || feedback.match(/([A-F][+-]?)\s*(?:\/|out of|\()/i);

                    result.output = { grade: gradeMatch?gradeMatch[1].toUpperCase():'—', feedback };
                    result.type = 'grade';
                    break;
                }

                default:
                    result.output = 'Unknown step';
            }

            return res.status(200).json(result);
        }

        return res.status(400).json({ success: false, error: 'Invalid action' });

    } catch(e) {
        console.error('[Agent] Error:', e);
        return res.status(500).json({ success: false, error: e.message });
    }
}
