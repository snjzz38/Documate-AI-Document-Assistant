// api/utils/googleSearch.js
import { GroqAPI } from './groqAPI.js';

// ─── Instance list ──────────────────────────────────────────────────
const SEARX_INSTANCES = [
    'https://search.sapti.me',
    'https://searx.tiekoetter.com',
    'https://search.bus-hit.me',
    'https://searx.be',
    'https://search.ononoki.org',
    'https://priv.au'
];

// Domains that are NEVER acceptable academic sources
const BANNED_DOMAINS = [
    'reddit', 'quora', 'stackoverflow', 'stackexchange',
    'youtube', 'tiktok', 'instagram', 'facebook', 'twitter', 'pinterest',
    'amazon', 'ebay', 'etsy', 'alibaba',
    'merriam-webster.com', 'dictionary.cambridge.org', 'wordreference',
    'thesaurus.com', 'vocabulary.com', 'definitions.net', 'urbandictionary',
    'wikipedia.org', 'britannica.com', 'wikihow.com', 'investopedia.com'
];

const BANNED_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
    '.mp4', '.mp3', '.pdf.jpg'
];

// Cross-disciplinary academic domains / publishers
const ACADEMIC_DOMAINS = [
    'edu', 'gov', 'pubmed', 'ncbi.nlm.nih.gov', 'jstor',
    'scholar.google', 'arxiv', 'nature.com', 'science.org',
    'springer', 'wiley', 'tandfonline', 'sagepub', 'oup.com',
    'cambridge.org/core', 'pnas.org', 'cell.com', 'bmj.com',
    'thelancet.com', 'doi.org', 'sciencedirect', 'frontiersin',
    'mdpi.com', 'worldscientific', 'ssrn.com', 'acm.org',
    'ieee.org', 'aps.org', 'iop.org', 'royalsocietypublishing.org',
    'plato.stanford.edu', 'philpapers.org', 'oxfordacademic.com',
    'tandfonline.com', 'eric.ed.gov'
];

// Words too generic to anchor any search query
const GENERIC_WORDS = new Set([
    'impact', 'importance', 'role', 'effect', 'affect', 'influence',
    'benefit', 'advantage', 'disadvantage', 'cause', 'result',
    'study', 'research', 'analysis', 'paper', 'article', 'review',
    'overview', 'introduction', 'conclusion', 'summary', 'discussion',
    'education', 'learning', 'development', 'growth', 'progress',
    'personal', 'societal', 'social', 'economic', 'academic',
    'main', 'three', 'one', 'two', 'first', 'second', 'third',
    'pillar', 'foundation', 'key', 'tool', 'thing', 'way', 'part',
    'make', 'made', 'take', 'get', 'use', 'used', 'using',
    'people', 'world', 'system', 'process', 'approach', 'method',
    'also', 'even', 'well', 'much', 'many', 'often', 'still'
]);

export const GoogleSearchAPI = {

    // ════════════════════════════════════════════════════════════════════
    // MAIN ENTRY — 4-stage pipeline
    //   1. Analyze topic → structured brief with discipline + off-topic map
    //   2. Generate discipline-anchored phrase queries from the brief
    //   3. Search OpenAlex + SearXNG in parallel
    //   4. Filter by relevance (static + LLM, both discipline-aware)
    // ════════════════════════════════════════════════════════════════════
    async search(query, apiKey, cx, groqKey = null) {
        // ── Stage 1 ──────────────────────────────────────────────────────
        let brief = null;
        if (groqKey) {
            brief = await this._analyzeTopic(query, groqKey);
            console.log('[Search] Brief:', JSON.stringify(brief, null, 2));
        }

        // ── Stage 2 ──────────────────────────────────────────────────────
        const queries = brief
            ? brief.queries
            : [this._buildFallbackQuery(query)];
        const exactTitleQueries = (brief?.known_seminal_works || []).map(w => `"${w}"`);
        const allQueries = [...queries, ...exactTitleQueries];
        console.log('[Search] Queries:', queries);

        // ── Stage 3 ──────────────────────────────────────────────────────
        const [openAlexResults, searxResultArrays] = await Promise.all([
            this._searchOpenAlex(queries, brief),
            Promise.all(queries.map(q => this._searchSearx(q)))
        ]);
        const searxResults = searxResultArrays.flat();
        const allResults = [...openAlexResults, ...searxResults];
        console.log(`[Search] Raw: OpenAlex=${openAlexResults.length}, SearXNG=${searxResults.length}`);

        // ── Static filter + score (uses brief.red_flags) ────────────────
        const filtered = this._filterAndScore(allResults, brief);
        console.log('[Search] After scoring:', filtered.length);

        // ── Stage 4: LLM relevance filter ───────────────────────────────
        const relevant = await this._filterByRelevance(filtered, query, groqKey, brief);
        console.log('[Search] After relevance:', relevant.length);

        return relevant;
    },

    // ════════════════════════════════════════════════════════════════════
    // STAGE 1 — TOPIC ANALYSIS
    // Produces phrase-based queries and must_engage_with lists, plus
    // dynamic off_topic_disciplines with red flags.
    // ════════════════════════════════════════════════════════════════════
    async _analyzeTopic(text, groqKey) {
        try {
            const prompt = `You are analyzing a student essay to prepare a "search brief" for finding academic sources.

ESSAY TEXT:
"${text.substring(0, 2500)}"

Return a JSON object with EXACTLY these fields:

{
  "discipline": "the specific academic discipline — e.g. 'philosophy of mathematics', 'macroeconomics', 'developmental psychology', 'comparative literature', 'environmental science'",
  "core_question": "the central question the essay tries to answer",
  "key_arguments": ["the 3-5 main claims or arguments the essay makes"],
  "named_entities": [
    {"name": "any proper noun, named theory, or distinctive phrase from the essay", "context": "how the essay uses it"}
  ],
  "off_topic_disciplines": [
    {
      "discipline": "name of a discipline that shares KEYWORDS with the essay but asks DIFFERENT questions",
      "red_flags": ["2-4 title words that reliably signal a paper is from THIS off-topic discipline, not the essay's discipline"]
    }
  ],
  "must_engage_with": [
    "3-5 specific phrases (NOT single keywords) that a TRULY relevant source MUST discuss",
    "A source engaging with NONE of these phrases is off-topic",
    "BAD: 'invention vs discovery', 'mathematical Platonism'. GOOD: 'mathematics as invention or discovery', 'mathematical Platonism realism', 'unreasonable effectiveness of mathematics'"
  ],
  "known_seminal_works": [
  "If the essay mentions a distinctive phrase that is the title of a famous academic work (e.g., 'unreasonable effectiveness', 'structure of scientific revolutions'), list that exact title here.",
  "These will be used for exact-match searches to find the original source."
  ],
  "queries": [
    "5-7 search queries that are NATURAL PHRASES of 4-8 words each",
    "Each query must be SELF-CONTEXTUALIZING — a reader who knows nothing about the essay should understand the phrase's meaning",
    "Each query must DISAMBIGUATE ambiguous terms. BAD: 'constructivism mathematics'. GOOD: 'philosophical constructivism mathematics invention'",
    "BAD: word-salad like 'mathematical Platonism Fibonacci sequence unreasonable effectiveness nature'. GOOD: 'is mathematics invented or discovered', 'Wigner unreasonable effectiveness of mathematics', 'Newton Leibniz calculus priority dispute'",
    "ALWAYS pair a concrete term from the essay with its philosophical/academic framing. Never search for bare concrete terms."
  ]
}

CRITICAL RULES:
1. "off_topic_disciplines" is the most important field for filtering. Think hard: what OTHER academic fields use the same keywords but ask completely different questions? For each, list 2-4 title words that are red flags. Examples:
   - Essay about "philosophy of mathematics" → off-topic: "mathematics education" (red flags: "classroom", "teaching", "student achievement", "instruction")
   - Essay about "economics of healthcare" → off-topic: "clinical medicine" (red flags: "patient outcomes", "treatment", "clinical trial", "therapeutic")
   - Essay about "sociology of religion" → off-topic: "theology" (red flags: "pastoral", "congregation", "ministry", "sermon")

2. "queries" must ALWAYS embed the discipline. Never search for bare concrete terms.
   BAD: "Fibonacci sequence"
   GOOD: "is mathematics invented or discovered"
   BAD: "constructivism mathematics"
   GOOD: "philosophical constructivism mathematics invention discovery"
   BAD: "healthcare costs"
   GOOD: "healthcare expenditure health economics public policy"

3. If a named theory or distinctive phrase appears (e.g. "unreasonable effectiveness", "social contract", "quantum entanglement"), include it in a query — these are the strongest search anchors.

4. Cover ALL sections of the essay, not just the introduction.

5. ENFORCE PHRASE LENGTH: Every query must be 4 to 8 words. No shorter, no longer.

Return ONLY raw JSON. No markdown fences. No explanation.`;

            const response = await GroqAPI.chat(
                [{ role: 'user', content: prompt }], groqKey, false
            );
            console.log('[Search] Brief raw:', response.substring(0, 200));

            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON object found');

            const brief = JSON.parse(jsonMatch[0]);

            // ── Validate & sanitize ──────────────────────────────────────
            if (!brief.queries?.length) throw new Error('No queries');
            if (!brief.off_topic_disciplines) brief.off_topic_disciplines = [];
            if (!brief.must_engage_with) brief.must_engage_with = [];
            if (!brief.named_entities) brief.named_entities = [];
            if (!brief.discipline) brief.discipline = '';
            if (!brief.core_question) brief.core_question = '';

            // Enforce 3-10 word length for queries (targeting 4-8 instructed)
            brief.queries = brief.queries
                .filter(q => typeof q === 'string')
                .map(q => q.trim())
                .filter(q => {
                    const wordCount = q.split(/\s+/).length;
                    return wordCount >= 3 && wordCount <= 10;
                })
                .map(q => q.substring(0, 150))
                .slice(0, 8);

            // Flatten red_flags for quick static access
            brief._redFlags = brief.off_topic_disciplines
                .flatMap(d => d.red_flags || [])
                .map(f => f.toLowerCase().trim())
                .filter(f => f.length > 2 && f.length < 40);

            if (brief.queries.length === 0) throw new Error('No valid queries after length filter');

            return brief;

        } catch (e) {
            console.error('[Search] _analyzeTopic failed:', e.message);
            return null;
        }
    },

    // ════════════════════════════════════════════════════════════════════
    // STAGE 3a — OpenAlex (real academic papers)
    // ════════════════════════════════════════════════════════════════════
    async _searchOpenAlex(queries, brief) {
        const allResults = [];

        // If we know the discipline, build a concept filter hint
        const disciplineHint = brief?.discipline
            ? ` ${brief.discipline}`
            : '';

        await Promise.all(queries.map(async (query) => {
            try {
                // Ensure discipline is in the query for OpenAlex
                const enrichedQuery = disciplineHint && !this._queryHasDiscipline(query, brief.discipline)
                    ? query + disciplineHint
                    : query;

                const url = `https://api.openalex.org/works?search=${encodeURIComponent(enrichedQuery)}&per-page=8&mailto=research@example.com`;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);

                const res = await fetch(url, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'AcademicCitationTool/1.0 (mailto:research@example.com)' }
                });
                clearTimeout(timeout);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const data = await res.json();

                for (const work of (data.results || [])) {
                    const doi = work.doi ||
                        (work.ids?.doi ? `https://doi.org/${work.ids.doi}` : null);
                    const link = doi || work.id;
                    if (!work.title || !link) continue;

                    const abstract = this._reconstructAbstract(work.abstract_inverted_index);
                    const authors = (work.authorships || [])
                        .map(a => a.author?.display_name)
                        .filter(Boolean)
                        .slice(0, 3)
                        .join(', ');

                    allResults.push({
                        title: work.title,
                        link,
                        snippet: abstract || '',
                        authors,
                        year: work.publication_year,
                        venue: work.primary_location?.source?.display_name || '',
                        source: 'openalex',
                        _score: 10
                    });
                }
            } catch (e) {
                console.error('[Search] OpenAlex error:', query, e.message);
            }
        }));

        return allResults;
    },

    /** Quick check: does the query already contain the discipline name? */
    _queryHasDiscipline(query, discipline) {
        if (!discipline) return true;
        const qLower = query.toLowerCase();
        return discipline.toLowerCase().split(/\s+/)
            .filter(w => w.length >= 3)
            .some(w => qLower.includes(w));
    },

    _reconstructAbstract(invertedIndex) {
        if (!invertedIndex || typeof invertedIndex !== 'object') return '';
        const positions = [];
        for (const [word, idxs] of Object.entries(invertedIndex)) {
            for (const i of idxs) positions.push([i, word]);
        }
        return positions
            .sort((a, b) => a[0] - b[0])
            .map(p => p[1])
            .join(' ')
            .substring(0, 400);
    },

    // ════════════════════════════════════════════════════════════════════
    // STAGE 3b — SearXNG (JSON-first, HTML fallback)
    // ════════════════════════════════════════════════════════════════════
    async _searchSearx(query) {
        const shuffled = [...SEARX_INSTANCES].sort(() => Math.random() - 0.5);

        for (const instance of shuffled.slice(0, 4)) {
            try {
                const url = `${instance}/search?q=${encodeURIComponent(query)}&categories=general,science&language=en&format=json`;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 8000);

                const res = await fetch(url, {
                    signal: controller.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    }
                });
                clearTimeout(timeout);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const contentType = res.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const data = await res.json();
                    const results = (data.results || [])
                        .map(r => ({ title: r.title || '', link: r.url || '', snippet: r.content || '' }))
                        .filter(r => r.title && r.link);
                    if (results.length > 0) {
                        console.log(`[Search] SearXNG JSON: ${results.length} from ${instance}`);
                        return results;
                    }
                } else {
                    const html = await res.text();
                    const results = this._parseResults(html);
                    if (results.length > 0) {
                        console.log(`[Search] SearXNG HTML: ${results.length} from ${instance}`);
                        return results;
                    }
                }
            } catch (e) {
                console.error('[Search] SearXNG failed:', instance, e.message);
            }
        }

        console.warn('[Search] All SearXNG instances failed for:', query);
        return [];
    },

    // ════════════════════════════════════════════════════════════════════
    // STATIC FILTER + SCORE + DEDUP
    // Uses brief._redFlags to reject papers from off-topic disciplines
    // that share keywords with the essay.
    // ════════════════════════════════════════════════════════════════════
    _filterAndScore(results, brief) {
        const seenUrls = new Set();
        const seenTitles = new Set();
        const seenDomains = new Set();
        const redFlags = brief?._redFlags || [];

        return results
            .filter(r => {
                if (!r.title || !r.link) return false;

                const lowerUrl = r.link.toLowerCase();
                const lowerTitle = r.title.toLowerCase();
                const lowerSnippet = (r.snippet || '').toLowerCase();

                if (BANNED_EXTENSIONS.some(ext => lowerUrl.includes(ext))) return false;
                if (lowerUrl.includes('/dictionary/') || lowerUrl.includes('/definition/')) return false;

                try {
                    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();

                    if (BANNED_DOMAINS.some(b => domain.includes(b))) return false;

                    // ── Discipline-aware red-flag filter ──────────────────
                    if (redFlags.length > 0) {
                        const titleFlags = redFlags.filter(f => lowerTitle.includes(f));
                        const snippetFlags = redFlags.filter(f => lowerSnippet.includes(f));

                        if (titleFlags.length >= 2) return false;
                        if (titleFlags.length >= 1 && snippetFlags.length >= 1) return false;
                        if (snippetFlags.length >= 3) return false;
                    }

                    const normalizedTitle = lowerTitle.substring(0, 60).trim();
                    if (seenTitles.has(normalizedTitle)) return false;
                    seenTitles.add(normalizedTitle);

                    if (seenUrls.has(lowerUrl)) return false;
                    seenUrls.add(lowerUrl);

                    const isAcademic = ACADEMIC_DOMAINS.some(p => domain.includes(p)) ||
                                       domain.endsWith('.edu') ||
                                       domain.endsWith('.gov');
                    if (!isAcademic && seenDomains.has(domain)) return false;
                    seenDomains.add(domain);

                    return true;
                } catch { return false; }
            })
            .map(r => {
                let score = r._score || 0;
                try {
                    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();

                    if (ACADEMIC_DOMAINS.some(p => domain.includes(p))) score += 5;
                    if (domain.endsWith('.edu')) score += 3;
                    if (domain.endsWith('.gov')) score += 3;
                    if (r.link.includes('doi.org')) score += 4;
                    if (r.authors) score += 2;
                    if (r.snippet && r.snippet.length > 100) score += 1;

                    if (domain.includes('blog')) score -= 3;
                    if (r.title.length < 15) score -= 2;
                    if (/\b(definition|meaning|what is)\b/i.test(r.title)) score -= 5;

                    if (redFlags.length > 0) {
                        const lowerTitle = r.title.toLowerCase();
                        const lowerSnippet = (r.snippet || '').toLowerCase();
                        const flagHits = redFlags.filter(f =>
                            lowerTitle.includes(f) || lowerSnippet.includes(f)
                        ).length;
                        score -= flagHits * 2;
                    }

                } catch {}
                return { ...r, _score: score };
            })
            .sort((a, b) => b._score - a._score)
            .slice(0, 20);
    },

    // ════════════════════════════════════════════════════════════════════
    // STAGE 4 — LLM RELEVANCE FILTER
    // Includes discipline gates, ambiguous-word rules, and concrete
    // examples to prevent same-keyword-different-field false positives.
    // ════════════════════════════════════════════════════════════════════
    async _filterByRelevance(results, originalText, groqKey, brief) {
        if (!groqKey || results.length === 0) return results;

        try {
            const summaries = results.map((r, i) =>
                `${i}: "${r.title}" — ${(r.snippet || '').substring(0, 250)}`
            ).join('\n');

            // ── Build context from the brief ─────────────────────────────
            let contextBlock;
            if (brief) {
                const offTopicLines = (brief.off_topic_disciplines || [])
                    .map(d => `  - ${d.discipline}: red flags ${JSON.stringify(d.red_flags || [])}`)
                    .join('\n');

                const disciplineLC = (brief.discipline || '').toLowerCase();

                contextBlock = `
DISCIPLINE: ${brief.discipline || '(unspecified)'}
CORE QUESTION: ${brief.core_question || '(unspecified)'}
A relevant source must engage with at least ONE of these phrases: ${JSON.stringify(brief.must_engage_with || [])}

OFF-TOPIC DISCIPLINES (share keywords but ask different questions):
 ${offTopicLines || '  (none identified)'}

DISCIPLINE GATE:
 ${disciplineLC.includes('philosophy') ? `- This essay is in PHILOSOPHY. REJECT any source whose title/venue contains: teaching, classroom, pedagogy, students, curriculum, instruction, learning outcomes, mathematics education, K-12, higher education teaching.` : ''}
 ${disciplineLC.includes('philosophy of mathematics') ? `- This essay is in PHILOSOPHY OF MATHEMATICS. ACCEPT only if the source discusses at least one of: Platonism, realism, nominalism, formalism, intuitionism, ontology of mathematics, epistemology of mathematics, mathematics invention, mathematics discovery.` : ''}

AMBIGUOUS-WORD RULE:
For these common ambiguity traps, apply the following logic:
- "constructivism": ACCEPT if paired with Platonism, realism, ontology. REJECT if paired with classroom, teaching, learning.
- "realism": ACCEPT if paired with mathematics, Platonism, ontology. REJECT if paired with art, literature, politics.
- "formalism": ACCEPT if paired with mathematics, logic, Hilbert. REJECT if paired with art, literature, law.
- "intuitionism": ACCEPT if paired with mathematics, Brouwer. REJECT if paired with psychology, ethics.
PHRASE-ECHO RULE: If a famous phrase from the essay is used as a metaphor or play-on-words in a different discipline (e.g., "unreasonable fairness" in Computer Science, "unreasonable ineffectiveness" in Economics), REJECT it. Only accept sources that discuss the phrase in its ORIGINAL context and discipline.

CONCRETE EXAMPLES OF WHAT TO REJECT (based on past failures for similar topics):
- "Student-centred learning: constructivism in the mathematics classroom" → REJECT (pedagogy, not philosophy)
- "Innovative approaches to teaching mathematics in higher education" → REJECT (math education, not philosophy)
- "Fibonacci scaling in k-Cullen sequences" → REJECT (pure math, no philosophical implications)
- "Jungian synchronicity and Fibonacci" → REJECT (psychology, not philosophy of math)

CONCRETE EXAMPLES OF WHAT TO ACCEPT:
- "Mathematical Platonism and the unreasonable effectiveness of mathematics" → ACCEPT
- "Is mathematics invented or discovered? A philosophical analysis" → ACCEPT
- "Newton, Leibniz, and the priority dispute over calculus" → ACCEPT`;
            } else {
                contextBlock = `
ESSAY TOPIC (first 800 chars):
"${originalText.substring(0, 800)}"

A relevant source must directly address the essay's central argument or question.`;
            }

            const prompt = `You are filtering search results for an academic essay.

 ${contextBlock}

SEARCH RESULTS:
 ${summaries}

TASK: Return ONLY the index numbers of results that:
1. Are ACADEMIC (peer-reviewed, journal article, scholarly book, .edu/.gov page, reputable research org)
2. Are from the SAME discipline as the essay or a closely related field
3. DIRECTLY ENGAGE with the core question — NOT merely share a keyword

STRICTLY EXCLUDE:
- Papers from off-topic disciplines (see red flags above) — even if they share keywords
- Dictionary / thesaurus / encyclopedia entries
- Commercial sites, brand websites
- Blog posts, forum threads, social media
- Papers that only USE a concept from the essay without examining it theoretically

Return ONLY a raw JSON array of index numbers, e.g.: [0, 1, 3, 5]`;

            const response = await GroqAPI.chat(
                [{ role: 'user', content: prompt }], groqKey, false
            );
            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) throw new Error('No JSON array');

            const indices = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(indices)) throw new Error('Not an array');

            const filtered = indices
                .filter(i => typeof i === 'number' && i >= 0 && i < results.length)
                .map(i => results[i]);

            return filtered.length > 0 ? filtered : results;

        } catch (e) {
            console.error('[Search] Relevance filter failed:', e.message);
            return results;
        }
    },

    // ════════════════════════════════════════════════════════════════════
    // FALLBACK QUERY BUILDER (when LLM brief is unavailable)
    // ════════════════════════════════════════════════════════════════════
    _buildFallbackQuery(text) {
        const stopWords = new Set([
            'the','a','an','is','are','was','were','be','been','being','have','has','had',
            'do','does','did','will','would','could','should','may','might','must','can',
            'this','that','these','those','they','their','what','which','who','where',
            'when','why','how','all','each','every','both','few','more','most','other',
            'some','such','no','nor','not','only','own','same','so','than','too','very',
            'just','also','now','people','things','many','much','often','even','well',
            'make','made','take','get','put','use','used','using','instead','through',
            ...GENERIC_WORDS
        ]);

        const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
        const meaningful = [...new Set(words)]
            .filter(w => !stopWords.has(w))
            .slice(0, 5);

        return (meaningful.join(' ') || 'academic research') + ' scholarly study';
    },

    // ════════════════════════════════════════════════════════════════════
    // HTML PARSER (SearXNG fallback when JSON unavailable)
    // ════════════════════════════════════════════════════════════════════
    _parseResults(html) {
        const results = [];

        const articleRegex = /<article[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
        let match;

        while ((match = articleRegex.exec(html)) !== null) {
            const block = match[1];
            const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/);
            const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) ||
                               block.match(/<a[^>]*>([\s\S]*?)<\/a>/);
            const snippetMatch = block.match(/<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/);

            if (urlMatch && titleMatch) {
                const url = urlMatch[1];
                const title = this._clean(titleMatch[1]);
                const snippet = snippetMatch ? this._clean(snippetMatch[1]) : '';
                if (title && url && !url.includes('searx')) {
                    results.push({ title, link: url, snippet });
                }
            }
        }

        if (results.length < 3) {
            const divRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
            while ((match = divRegex.exec(html)) !== null) {
                const block = match[1];
                const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/);
                const titleMatch = block.match(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/);
                if (urlMatch && titleMatch) {
                    const url = urlMatch[1];
                    const title = this._clean(titleMatch[1]);
                    if (title && !url.includes('searx') && !results.some(r => r.link === url)) {
                        results.push({ title, link: url, snippet: '' });
                    }
                }
            }
        }

        return results.slice(0, 30);
    },

    _clean(html) {
        return (html || '')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 300);
    }
};
