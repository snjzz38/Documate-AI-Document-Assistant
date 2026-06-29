// api/utils/googleSearch.js
import { GroqAPI } from './groqAPI.js';

const SEARX_INSTANCES = [
    'https://searx.oloke.xyz',
    'https://searxng.website',
    'https://failsearx.culturanerd.it',
    'https://searxng.shreven.org',
    'https://searx.tiekoetter.com',
    'https://searx.linxx.net',
    'https://searx.ononoki.org',
    'https://search.einfachzocken.eu',
    'https://search.rhscz.eu',
    'https://searx.rhscz.eu',
    'https://search.bladerunn.in',
    'https://searx.namejeff.xyz',
    'https://search.ctq.ro',
    'https://search.femboy.ad',
    'https://www.gruble.de',
    'https://search.sapti.me',
    'https://search.privacyredirect.com',
    'https://ooglester.com',
    'https://search.undertale.uk',
    'https://xka.cz',
    'https://paulgo.io',
    'https://search.2b9t.xyz',
    'https://search.catboy.house',
    'https://search.ethibox.fr',
    'https://search.hbubli.cc',
    'https://search.im-in.space',
    'https://search.rowie.at',
    'https://search.url4irl.com',
    'https://searxng.site',
    'https://searx.sev.monster',
    'https://search.unredacted.org',
    'https://search.root.hr',
    'https://searx.mxchange.org',
    'https://searxng.gr',
    'https://searxng.fishfvch.com'
];

const BANNED_DOMAINS = [
    'reddit', 'quora', 'stackoverflow', 'stackexchange',
    'youtube', 'tiktok', 'instagram', 'facebook', 'twitter', 'pinterest',
    'amazon', 'ebay', 'etsy', 'alibaba',
    'merriam-webster.com', 'dictionary.cambridge.org', 'wordreference',
    'thesaurus.com', 'vocabulary.com', 'definitions.net', 'urbandictionary',
    'impact.com', 'watchimpact.com', 'impactmobile', 'impacttest.com',
    'wikipedia.org', 'britannica.com', 'wikihow.com', 'investopedia.com'
];

const BANNED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp4', '.mp3', '.pdf.jpg'];

const PREFERRED_DOMAINS = [
    'edu', 'gov', 'pubmed', 'ncbi.nlm.nih.gov', 'jstor',
    'scholar.google', 'arxiv', 'nature.com', 'science.org',
    'springer', 'wiley', 'tandfonline', 'sagepub', 'oup.com',
    'cambridge.org/core', 'pnas.org', 'cell.com', 'bmj.com', 'thelancet.com',
    'doi.org', 'sciencedirect', 'frontiersin', 'mdpi.com',
    'taylorfrancis.com', 'worldscientific', 'eric.ed.gov', 'ssrn.com',
    'plato.stanford.edu'  // SEP — gold standard for philosophy
];

const GENERIC_WORDS = new Set([
    'impact', 'importance', 'role', 'effect', 'affect', 'influence',
    'benefit', 'advantage', 'disadvantage', 'cause', 'result',
    'study', 'research', 'analysis', 'paper', 'article', 'review',
    'overview', 'introduction', 'conclusion', 'summary', 'discussion',
    'education', 'learning', 'development', 'growth', 'progress',
    'personal', 'societal', 'social', 'economic', 'academic',
    'main', 'three', 'one', 'two', 'first', 'second', 'third',
    'pillar', 'foundation', 'key', 'tool'
]);

export const GoogleSearchAPI = {

    // ════════════════════════════════════════════════════════════════════
    // MAIN ENTRY POINT — now uses a 4-stage pipeline:
    //   1. Analyze topic → produce a structured "search brief"
    //   2. Generate paired (concrete + abstract) queries from the brief
    //   3. Search OpenAlex + SearXNG in parallel
    //   4. Filter by relevance using the brief as ground truth
    // ════════════════════════════════════════════════════════════════════
    async search(query, apiKey, cx, groqKey = null) {
        // ── Initialize network stats tracking ───────────────────────────
        const stats = this._createStats();
        stats.startedAt = Date.now();

        // ── Stage 1: Topic Analysis ──────────────────────────────────────
        let brief = null;
        if (groqKey) {
            brief = await this._analyzeTopic(query, groqKey, stats);
            console.log('[Search] Topic brief:', JSON.stringify(brief, null, 2));
        }

        // ── Stage 2: Query Generation (uses brief) ───────────────────────
        const queries = brief
            ? brief.queries
            : [this._buildFallbackQuery(query)];
        stats.queriesGenerated = queries.length;
        console.log('[Search] Generated queries:', queries);

        // ── Stage 3: Search OpenAlex + SearXNG in parallel ──────────────
        stats.stages.parallelSearch.startedAt = Date.now();
        const [openAlexResults, searxResultArrays] = await Promise.all([
            this._searchOpenAlex(queries, stats),
            Promise.all(queries.map(q => this._searchSearx(q, stats)))
        ]);
        const searxResults = searxResultArrays.flat();
        stats.stages.parallelSearch.finishedAt = Date.now();
        stats.stages.parallelSearch.ms =
            stats.stages.parallelSearch.finishedAt - stats.stages.parallelSearch.startedAt;

        const allResults = [...openAlexResults, ...searxResults];
        stats.results.raw = allResults.length;
        console.log(`[Search] Raw: OpenAlex=${openAlexResults.length}, SearXNG=${searxResults.length}`);

        const filtered = this._filterAndScore(allResults);
        stats.results.afterScoring = filtered.length;
        console.log('[Search] After scoring:', filtered.length);

        // ── Stage 4: Relevance filter (uses brief) ───────────────────────
        const relevant = await this._filterByRelevance(filtered, query, groqKey, brief, stats);
        stats.results.afterFilter = relevant.length;
        console.log('[Search] After relevance filter:', relevant.length);

        // ── Finalize stats ───────────────────────────────────────────────
        stats.finishedAt = Date.now();
        stats.elapsedMs = stats.finishedAt - stats.startedAt;
        stats.totals.externalRequests =
            stats.totals.groqCalls + stats.totals.httpRequests;
        stats.totals.failedRequests =
            stats.stages.topicAnalysis.failures +
            stats.stages.openalex.failures +
            stats.stages.searxng.failures +
            stats.stages.filter.failures;
        stats.totals.successRate =
            stats.totals.externalRequests > 0
                ? +(1 - stats.totals.failedRequests / stats.totals.externalRequests).toFixed(3)
                : 1;

        // Attach stats as a non-enumerable property on the results array
        // so callers can do `results.stats` without it appearing in JSON.stringify
        Object.defineProperty(relevant, 'stats', {
            value: stats,
            enumerable: false,
            writable: false
        });

        return relevant;
    },

    // ════════════════════════════════════════════════════════════════════
    // NETWORK STATS — initialize a fresh stats object per search() call.
    // Returned as `results.stats` so the UI can render efficiency metrics.
    // ════════════════════════════════════════════════════════════════════
    _createStats() {
        return {
            startedAt: null,
            finishedAt: null,
            elapsedMs: 0,
            queriesGenerated: 0,
            stages: {
                topicAnalysis: { calls: 0, failures: 0, ms: 0, ok: false },
                parallelSearch: { startedAt: null, finishedAt: null, ms: 0 },
                openalex: { calls: 0, failures: 0, ms: 0, resultsReturned: 0 },
                searxng:   { calls: 0, failures: 0, ms: 0, resultsReturned: 0, instancesTried: 0 },
                filter:    { calls: 0, failures: 0, ms: 0, ok: false }
            },
            results: {
                raw: 0,
                afterScoring: 0,
                afterFilter: 0
            },
            totals: {
                externalRequests: 0,
                groqCalls: 0,
                httpRequests: 0,
                failedRequests: 0,
                successRate: 1
            }
        };
    },

    // Tiny timing helper — wraps an async fn and returns { result, ms }
    async _time(fn) {
        const start = Date.now();
        try {
            const result = await fn();
            return { result, ms: Date.now() - start, ok: true };
        } catch (e) {
            return { result: null, ms: Date.now() - start, ok: false, error: e };
        }
    },

    // ════════════════════════════════════════════════════════════════════
    // STAGE 1: TOPIC ANALYSIS
    // One Groq call that reads the whole essay and produces a structured
    // "search brief" — the single source of truth used by both query
    // generation and the relevance filter.
    // ════════════════════════════════════════════════════════════════════
    async _analyzeTopic(text, groqKey, stats) {
        const stage = stats.stages.topicAnalysis;
        stage.calls += 1;
        stats.totals.groqCalls += 1;
        const start = Date.now();
        try {
            const prompt = `You are analyzing a student essay to prepare a "search brief" for finding academic sources.

ESSAY TEXT:
"${text.substring(0, 2500)}"

TASK: Analyze the essay and return a JSON object with these fields:

{
  "core_thesis": "one-sentence summary of the essay's central argument",
  "central_question": "the specific question the essay is trying to answer",
  "philosophical_positions": ["list of named philosophical positions, theories, or frameworks the essay engages with — e.g., 'Mathematical Platonism', 'Constructivism', 'Formalism'"],
  "discipline": "the academic discipline this essay belongs to — e.g., 'philosophy of mathematics', 'epistemology', 'sociology of education'",
  "named_entities": [
    {"name": "specific named thing from essay", "role": "how it's used in the argument — e.g., 'evidence for math in nature'", "abstract_framing": "the philosophical claim it supports"}
  ],
  "must_engage_with": ["3-6 short PHRASES (not single keywords) that capture the essay's core claims — e.g., 'mathematics as invention or discovery', 'mathematical Platonism realism', 'unreasonable effectiveness of mathematics'", "each phrase must be self-contained and carry its own context"],
  "queries": [
    "5-8 NATURAL SEARCH PHRASES — short, readable phrases of 4-8 words each",
    "each phrase must read like a coherent description of a specific claim or question from the essay",
    "each phrase must be self-contextualizing — a reader who knows nothing about the essay should understand what the phrase is about",
    "phrases should be the kind of text likely to appear in an academic paper TITLE or ABSTRACT"
  ]
}

CRITICAL RULES:
1. ALWAYS return PHRASES, not keyword lists. A phrase reads naturally; a keyword list is just words jammed together.
   - BAD (keyword list): "mathematical Platonism Fibonacci sequence unreasonable effectiveness nature"
   - GOOD (phrase): "is mathematics invented or discovered"
   - GOOD (phrase): "Wigner unreasonable effectiveness of mathematics"
   - GOOD (phrase): "Newton Leibniz independent discovery of calculus"
   - GOOD (phrase): "mathematical Platonism versus constructivism"
2. Each phrase must SELF-CONTEXTUALIZE. If a word is ambiguous (e.g., "constructivism" could mean pedagogy OR philosophy of math), the phrase itself must disambiguate:
   - BAD: "constructivism mathematics classroom" (could be pedagogy)
   - GOOD: "philosophical constructivism mathematics invention"
   - BAD: "realism mathematics" (could be art realism or math realism)
   - GOOD: "mathematical realism and Platonism ontology"
3. The "queries" must cover EVERY distinct section/argument of the essay, not just the first.
4. The "must_engage_with" field is the ground truth for filtering — a source that doesn't engage with at least ONE of these is OFF-TOPIC, even if it shares a keyword.
5. Discipline qualification: if the essay is philosophical, every query phrase should make the philosophical context explicit. Add words like "philosophy of", "epistemology", "ontology", "debate", "argument" where appropriate so the phrase surfaces PHILOSOPHY papers, not pure-math or pedagogy papers.
6. If a named philosopher/theorist is mentioned, include them by name in a phrase.
7. Each phrase must be 4-8 words. Not fewer (too vague), not more (too narrow for full-text search).

Return ONLY the raw JSON object, no explanation, no markdown.`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            console.log('[Search] Topic analysis raw:', response.substring(0, 200));

            // Extract JSON object (not array — use { ... } match)
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON object in response');

            const brief = JSON.parse(jsonMatch[0]);
            stage.ms = Date.now() - start;
            stage.ok = true;

            // Validate required fields
            if (!brief.queries || !Array.isArray(brief.queries) || brief.queries.length === 0) {
                throw new Error('Missing queries array');
            }
            if (!brief.must_engage_with || !Array.isArray(brief.must_engage_with)) {
                brief.must_engage_with = [];
            }

            // Sanitize queries — enforce 4-8 word phrase length
            brief.queries = brief.queries
                .filter(q => typeof q === 'string')
                .map(q => q.trim().substring(0, 150))
                .filter(q => {
                    const wordCount = q.split(/\s+/).length;
                    return wordCount >= 4 && wordCount <= 8;
                })
                .slice(0, 8);

            if (brief.queries.length === 0) throw new Error('No valid queries after cleaning');

            return brief;

        } catch (e) {
            stage.ms = Date.now() - start;
            stage.failures += 1;
            console.error('[Search] _analyzeTopic failed:', e.message);
            return null;  // falls back to old query extraction
        }
    },

    // ════════════════════════════════════════════════════════════════════
    // STAGE 3a: OpenAlex search (unchanged — real academic papers)
    // ════════════════════════════════════════════════════════════════════
    async _searchOpenAlex(queries, stats) {
        const allResults = [];
        const stage = stats.stages.openalex;

        await Promise.all(queries.map(async (query) => {
            const start = Date.now();
            stage.calls += 1;
            stats.totals.httpRequests += 1;
            try {
                const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=15&mailto=research@example.com`;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);

                const res = await fetch(url, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'AcademicCitationTool/1.0 (mailto:research@example.com)' }
                });
                clearTimeout(timeout);

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                stage.ms += Date.now() - start;

                for (const work of (data.results || [])) {
                    const doi = work.doi || (work.ids?.doi ? `https://doi.org/${work.ids.doi}` : null);
                    const link = doi || work.id;
                    const abstract = this._reconstructAbstract(work.abstract_inverted_index);
                    const authors = (work.authorships || [])
                        .map(a => a.author?.display_name)
                        .filter(Boolean)
                        .slice(0, 3)
                        .join(', ');

                    if (!work.title || !link) continue;

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
                stage.resultsReturned += (data.results || []).length;
            } catch (e) {
                stage.ms += Date.now() - start;
                stage.failures += 1;
                console.error('[Search] OpenAlex failed for query:', query, e.message);
            }
        }));

        return allResults;
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
    // STAGE 3b: SearXNG search (unchanged — JSON-first, HTML fallback)
    // ════════════════════════════════════════════════════════════════════
    async _searchSearx(query, stats) {
        const stage = stats.stages.searxng;
        const shuffled = [...SEARX_INSTANCES].sort(() => Math.random() - 0.5);

        for (const instance of shuffled.slice(0, 4)) {
            const start = Date.now();
            stage.calls += 1;
            stage.instancesTried += 1;
            stats.totals.httpRequests += 1;
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
                stage.ms += Date.now() - start;

                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const contentType = res.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const data = await res.json();
                    const results = (data.results || [])
                        .map(r => ({
                            title: r.title || '',
                            link: r.url || '',
                            snippet: r.content || ''
                        }))
                        .filter(r => r.title && r.link);
                    if (results.length > 0) {
                        stage.resultsReturned += results.length;
                        console.log('[Search] SearXNG JSON:', results.length, 'from', instance);
                        return results;
                    }
                } else {
                    const html = await res.text();
                    const results = this._parseResults(html);
                    if (results.length > 0) {
                        stage.resultsReturned += results.length;
                        console.log('[Search] SearXNG HTML:', results.length, 'from', instance);
                        return results;
                    }
                }
            } catch (e) {
                stage.failures += 1;
                console.error('[Search] SearXNG instance failed:', instance, e.message);
            }
        }

        console.warn('[Search] All SearXNG instances failed for:', query);
        return [];
    },

    // ════════════════════════════════════════════════════════════════════
    // STAGE 4: RELEVANCE FILTER (now uses the brief as ground truth)
    // Key change: instead of "is this relevant to the topic?", we now ask
    // "does this paper ENGAGE WITH the central question — or merely
    // mention a keyword?" The brief's must_engage_with list is the
    // pass/fail criterion.
    // ════════════════════════════════════════════════════════════════════
    async _filterByRelevance(results, originalText, groqKey, brief, stats) {
        const stage = stats ? stats.stages.filter : null;
        if (stage) { stage.calls += 1; stats.totals.groqCalls += 1; }
        const start = stats ? Date.now() : 0;

        if (!groqKey || results.length === 0) {
            if (stage) { stage.ms = Date.now() - start; stage.ok = true; }
            return results;
        }

        try {
            const summaries = results.map((r, i) =>
                `${i}: "${r.title}" — ${(r.snippet || '').substring(0, 250)}`
            ).join('\n');

            // Build context from the brief if available
            const briefContext = brief ? `
GROUND TRUTH (from topic analysis):
- Central question: ${brief.central_question || '(unspecified)'}
- Discipline: ${brief.discipline || '(unspecified)'}
- Philosophical positions engaged: ${JSON.stringify(brief.philosophical_positions || [])}
- A source is RELEVANT only if it engages with at least ONE of these phrases: ${JSON.stringify(brief.must_engage_with || [])}

PASS CRITERION: The source must actually ARGUE about or ANALYZE the central question (or one of the philosophical positions), NOT merely mention a keyword that also appears in the essay.

DISCIPLINE GATE — if the brief's discipline contains "philosophy":
  STRICTLY REJECT any source whose title or venue contains pedagogy/education terms:
  teaching, classroom, pedagogy, students, curriculum, instruction, learning outcomes,
  mathematics education, science education, K-12, higher education teaching
  These are pedagogy papers sharing a keyword, NOT philosophical engagements.

DISCIPLINE GATE — if the brief's discipline contains "philosophy of mathematics":
  ACCEPT only if the source discusses at least one of: Platonism, realism, nominalism,
  formalism, intuitionism, constructivism (the philosophical position, NOT pedagogy),
  ontology of mathematics, epistemology of mathematics, mathematics invention,
  mathematics discovery, philosophy of mathematics

AMBIGUOUS-WORD RULE — these words have multiple meanings; only accept if context confirms the philosophical sense:
  - "constructivism": ACCEPT if paired with Platonism/realism/ontology; REJECT if paired with classroom/teaching/learning
  - "realism": ACCEPT if paired with mathematics/Platonism/ontology; REJECT if paired with art/literature/politics
  - "formalism": ACCEPT if paired with mathematics/logic/Hilbert; REJECT if paired with art/literature/law
  - "intuitionism": ACCEPT if paired with mathematics/Brouwer; REJECT if paired with psychology/ethics

EXAMPLES OF WHAT TO REJECT (for an essay on philosophy of mathematics):
- Source: "Student-centred learning: constructivism in the mathematics classroom" → REJECT (pedagogy, not philosophy)
- Source: "Innovative approaches to teaching mathematics in higher education" → REJECT (math education, not philosophy)
- Source: "Fibonacci scaling in k-Cullen sequences" → REJECT (pure math, no philosophical engagement)
- Source: "Jungian synchronicity and Fibonacci" → REJECT (psychology, shares keyword only)

EXAMPLES OF WHAT TO ACCEPT:
- Source: "Mathematical Platonism and the unreasonable effectiveness of mathematics" → ACCEPT
- Source: "Is mathematics invented or discovered? A philosophical analysis" → ACCEPT
- Source: "Newton, Leibniz, and the priority dispute over calculus" → ACCEPT (philosophical/historical engagement)
` : `
ESSAY TOPIC SUMMARY (first 800 chars):
"${originalText.substring(0, 800)}"
`;

            const prompt = `You are filtering search results for an academic essay.

${briefContext}

SEARCH RESULTS:
${summaries}

TASK: Return ONLY the index numbers of results that satisfy ALL of:
1. ACADEMIC in nature (peer-reviewed paper, journal article, scholarly book chapter, .edu page, .gov report, reputable research org)
2. DIRECTLY ENGAGES with the essay's central question or one of its philosophical positions — NOT merely shares a keyword
3. PASSES the DISCIPLINE GATE above (if brief discipline is philosophy, reject pedagogy/education papers)
4. PASSES the AMBIGUOUS-WORD RULE above (if title hinges on an ambiguous term, only accept if context confirms the philosophical sense)

STRICTLY EXCLUDE:
- Pure-math / pure-science papers that use a keyword from the essay but don't discuss its philosophical implications
- Pedagogy / education papers that share a keyword (e.g., "constructivism in the classroom")
- Psychology, sociology, linguistics papers that share a keyword but aren't about the essay's actual question
- Dictionary / thesaurus / encyclopedia entries
- Book reviews (cite the book itself, not the review) unless the review itself makes substantive philosophical arguments
- Commercial sites, brand websites, TV networks
- Blog posts, forum threads, social media

Return ONLY a raw JSON array of index numbers, e.g.: [0, 1, 3, 5]`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            if (stage) stage.ms = Date.now() - start;
            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) throw new Error('No JSON array');

            const indices = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(indices)) throw new Error('Not an array');

            const filtered = indices
                .filter(i => typeof i === 'number' && i >= 0 && i < results.length)
                .map(i => results[i]);

            if (stage) stage.ok = true;
            return filtered.length > 0 ? filtered : results;

        } catch (e) {
            if (stage) { stage.ms = Date.now() - start; stage.failures += 1; }
            console.error('[Search] Relevance filter failed:', e.message);
            return results;
        }
    },

    // ════════════════════════════════════════════════════════════════════
    // Filter + score + dedup (unchanged from v2)
    // ════════════════════════════════════════════════════════════════════
    _filterAndScore(results) {
    const seenUrls = new Set();
    const seenTitles = new Set();
    const seenDomains = new Set();

    return results
        .filter(r => {
            if (!r.title || !r.link) return false;

            const lowerUrl = r.link.toLowerCase();
            const lowerTitle = r.title.toLowerCase();

            if (BANNED_EXTENSIONS.some(ext => lowerUrl.includes(ext))) return false;
            if (lowerUrl.includes('/dictionary/') || lowerUrl.includes('/definition/')) return false;

            try {
                const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
                if (BANNED_DOMAINS.some(b => domain.includes(b))) return false;

                // ─────────────────────────────────────────────
                // THE FIX: Add openalex.org and doi.org here!
                // ─────────────────────────────────────────────
                const isAcademic = PREFERRED_DOMAINS.some(p => domain.includes(p)) ||
                                   domain.endsWith('.edu') || 
                                   domain.endsWith('.gov') ||
                                   domain.includes('openalex.org') ||  // <--- ADD THIS
                                   domain.includes('doi.org');        // <--- ADD THIS

                const normalizedTitle = lowerTitle.substring(0, 60).trim();
                if (seenTitles.has(normalizedTitle)) return false;
                seenTitles.add(normalizedTitle);

                if (seenUrls.has(lowerUrl)) return false;
                seenUrls.add(lowerUrl);

                // Now OpenAlex results won't be falsely deduplicated by domain
                if (!isAcademic) {
                    if (seenDomains.has(domain)) return false;
                    seenDomains.add(domain);
                }
                return true;
            } catch { return false; }
            })
            .map(r => {
                let score = r._score || 0;
                try {
                    const domain = new URL(r.link).hostname.replace('www.', '').toLowerCase();
                    if (PREFERRED_DOMAINS.some(p => domain.includes(p))) score += 5;
                    if (domain.endsWith('.edu')) score += 3;
                    if (domain.endsWith('.gov')) score += 3;
                    if (r.link.includes('doi.org')) score += 4;
                    if (domain.includes('blog')) score -= 3;
                    if (r.title.length < 15) score -= 2;
                    if (r.snippet && r.snippet.length > 100) score += 1;
                    if (/\b(definition|meaning|what is)\b/i.test(r.title)) score -= 5;
                    if (r.authors) score += 2;
                } catch {}
                return { ...r, _score: score };
            })
            .sort((a, b) => b._score - a._score)
            .slice(0, 15);
    },

    // ════════════════════════════════════════════════════════════════════
    // Fallback query builder (used only if topic analysis fails)
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
            .slice(0, 4);

        return (meaningful.join(' ') || 'education research') + ' academic study';
    },

    // ════════════════════════════════════════════════════════════════════
    // HTML parser (SearXNG fallback)
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
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ').trim().substring(0, 300);
    }
};
