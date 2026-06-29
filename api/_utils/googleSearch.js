// ==========================================================================
// FILE PATH: api/_utils/googleSearch.js
// ==========================================================================

/*
 * TABLE OF CONTENTS
 * -------------------------------------------------------
 * 1. CONFIGURATION & CONSTANTS
 *    - Banned domains, preferred academic domains, stop words
 * 
 * 2. CORE INTERFACE
 *    - GoogleSearchAPI.search() - The main pipeline orchestrator
 * 
 * 3. STAGE 1: TOPIC ANALYSIS
 *    - _analyzeTopic() - Uses Groq to build a "Search Brief" from the essay
 * 
 * 4. STAGE 2: QUERY GENERATION
 *    - _buildFallbackQuery() - Creates queries if Groq fails
 * 
 * 5. STAGE 3: DATA ACQUISITION (OpenAlex)
 *    - _searchOpenAlex() - Fetches real academic papers via API
 *    - _reconstructAbstract() - Decodes OpenAlex's inverted index format
 * 
 * 6. STAGE 4: SCORING & DEDUPLICATION
 *    - _filterAndScore() - Removes junk, fixes domain bugs, ranks results
 * 
 * 7. STAGE 5: AI RELEVANCE FILTERING
 *    - _filterByRelevance() - Uses Groq to separate 5-star from 1-star papers
 * 
 * 8. UTILITIES & HELPERS
 *    - _createStats() - Initializes network tracking object
 *    - _time() - Async timing wrapper
 */

import { GroqAPI } from './groqAPI.js';

// ════════════════════════════════════════════════════════════════════════════
// MODULE 1: CONFIGURATION & CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const BANNED_DOMAINS = [
    'reddit', 'quora', 'stackoverflow', 'stackexchange',
    'youtube', 'tiktok', 'instagram', 'facebook', 'twitter', 'pinterest',
    'amazon', 'ebay', 'etsy', 'alibaba',
    'merriam-webster.com', 'dictionary.cambridge.org', 'wordreference',
    'thesaurus.com', 'vocabulary.com', 'definitions.net', 'urbandictionary',
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
    'plato.stanford.edu'
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

const MINIMUM_RESULTS = 6; // Never return fewer than this many sources


// ════════════════════════════════════════════════════════════════════════════
// MODULE 2: CORE INTERFACE
// ════════════════════════════════════════════════════════════════════════════

export const GoogleSearchAPI = {

    /**
     * Main entry point. Orchestrates the 5-stage pipeline.
     */
    async search(query, apiKey, cx, groqKey = null) {
        const stats = this._createStats();
        stats.startedAt = Date.now();

        // Stage 1: Analyze Topic
        let brief = null;
        if (groqKey) {
            brief = await this._analyzeTopic(query, groqKey, stats);
        }

        // Stage 2: Generate Queries
        const queries = brief ? brief.queries : [this._buildFallbackQuery(query)];
        stats.queriesGenerated = queries.length;

        // Stage 3: Fetch from OpenAlex
        const openAlexResults = await this._searchOpenAlex(queries, stats);
        stats.results.raw = openAlexResults.length;

        // Stage 4: Score and Deduplicate
        const scoredResults = this._filterAndScore(openAlexResults);
        stats.results.afterScoring = scoredResults.length;

        // Stage 5: AI Relevance Filter
        const relevantResults = await this._filterByRelevance(scoredResults, query, groqKey, brief, stats);
        stats.results.afterFilter = relevantResults.length;

        // Finalize Stats
        stats.finishedAt = Date.now();
        stats.elapsedMs = stats.finishedAt - stats.startedAt;
        stats.totals.externalRequests = stats.totals.groqCalls + stats.totals.httpRequests;
        stats.totals.failedRequests = stats.stages.topicAnalysis.failures + stats.stages.openalex.failures + stats.stages.filter.failures;
        stats.totals.successRate = stats.totals.externalRequests > 0 ? +(1 - stats.totals.failedRequests / stats.totals.externalRequests).toFixed(3) : 1;

        Object.defineProperty(relevantResults, 'stats', { value: stats, enumerable: false, writable: false });

        return relevantResults;
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 3: STAGE 1 - TOPIC ANALYSIS
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Uses Groq to read the essay and create a structured "Search Brief".
     * This brief acts as ground truth for later filtering.
     */
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
1. ALWAYS return PHRASES, not keyword lists.
   - BAD (keyword list): "mathematical Platonism Fibonacci sequence unreasonable effectiveness nature"
   - GOOD (phrase): "is mathematics invented or discovered"
2. Each phrase must SELF-CONTEXTUALIZE. Disambiguate terms (e.g., philosophical constructivism vs. teaching constructivism).
3. The "queries" must cover EVERY distinct section/argument of the essay.
4. Discipline qualification: if philosophical, add words like "philosophy of", "ontology", "debate" to surface PHILOSOPHY papers, not pure-math or pedagogy.
5. Each phrase must be 4-8 words.

Return ONLY the raw JSON object, no markdown.`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON object in response');

            const brief = JSON.parse(jsonMatch[0]);
            stage.ms = Date.now() - start;
            stage.ok = true;

            brief.queries = brief.queries
                .filter(q => typeof q === 'string')
                .map(q => q.trim().substring(0, 150))
                .filter(q => { const wc = q.split(/\s+/).length; return wc >= 4 && wc <= 8; })
                .slice(0, 8);

            if (brief.queries.length === 0) throw new Error('No valid queries');
            return brief;

        } catch (e) {
            stage.ms = Date.now() - start;
            stage.failures += 1;
            console.error('[Search] _analyzeTopic failed:', e.message);
            return null;
        }
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 4: STAGE 2 - QUERY GENERATION
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Fallback if Groq topic analysis fails. Extracts keywords and joins them.
     */
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
        const meaningful = [...new Set(words)].filter(w => !stopWords.has(w)).slice(0, 4);
        return (meaningful.join(' ') || 'education research') + ' academic study';
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 5: STAGE 3 - DATA ACQUISITION (OPENALEX)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Fetches papers from OpenAlex API in parallel.
     */
    async _searchOpenAlex(queries, stats) {
        const allResults = [];
        const stage = stats.stages.openalex;

        await Promise.all(queries.map(async (query) => {
            const start = Date.now();
            stage.calls += 1;
            stats.totals.httpRequests += 1;
            try {
                // Increased per-page to 15 for a larger net
                const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=15&mailto=research@example.com`;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 12000);

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
                    const authors = (work.authorships || []).map(a => a.author?.display_name).filter(Boolean).slice(0, 3).join(', ');

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

    /**
     * OpenAlex returns abstracts as { word: [position_indices] }. This rebuilds it into a string.
     */
    _reconstructAbstract(invertedIndex) {
        if (!invertedIndex || typeof invertedIndex !== 'object') return '';
        const positions = [];
        for (const [word, idxs] of Object.entries(invertedIndex)) {
            for (const i of idxs) positions.push([i, word]);
        }
        return positions.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' ').substring(0, 400);
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 6: STAGE 4 - SCORING & DEDUPLICATION
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Removes junk, deduplicates by URL/Title, and applies domain-based scoring.
     * BUG FIX: Explicitly marks openalex.org and doi.org as academic so they 
     * aren't falsely deduplicated by domain limits.
     */
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

                    const normalizedTitle = lowerTitle.substring(0, 60).trim();
                    if (seenTitles.has(normalizedTitle)) return false;
                    seenTitles.add(normalizedTitle);

                    if (seenUrls.has(lowerUrl)) return false;
                    seenUrls.add(lowerUrl);

                    // THE FIX: Treat OpenAlex and DOI links as academic so we don't cap them at 1 per domain
                    const isAcademic = PREFERRED_DOMAINS.some(p => domain.includes(p)) ||
                                       domain.endsWith('.edu') || 
                                       domain.endsWith('.gov') ||
                                       domain.includes('openalex.org') || 
                                       domain.includes('doi.org');

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
            .slice(0, 20); // Feed top 20 to the AI filter
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 7: STAGE 5 - AI RELEVANCE FILTERING
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Uses Groq to separate 5-star sources from 1-star sources based on the Search Brief.
     * ENFORCE MINIMUM THRESHOLD: If Groq is too strict, falls back to top-scored papers.
     */
    async _filterByRelevance(results, originalText, groqKey, brief, stats) {
        const stage = stats ? stats.stages.filter : null;
        if (stage) { stage.calls += 1; stats.totals.groqCalls += 1; }
        const start = stats ? Date.now() : 0;

        if (!groqKey || results.length === 0) {
            if (stage) { stage.ms = Date.now() - start; stage.ok = true; }
            return results;
        }

        try {
            const summaries = results.map((r, i) => `${i}: "${r.title}" — ${(r.snippet || '').substring(0, 250)}`).join('\n');

            const briefContext = brief ? `
GROUND TRUTH (from topic analysis):
- Central question: ${brief.central_question || '(unspecified)'}
- Discipline: ${brief.discipline || '(unspecified)'}
- Philosophical positions engaged: ${JSON.stringify(brief.philosophical_positions || [])}
- A source is RELEVANT only if it engages with at least ONE of these phrases: ${JSON.stringify(brief.must_engage_with || [])}

PASS CRITERION: The source must actually ARGUE about or ANALYZE the central question (or one of the philosophical positions), NOT merely mention a keyword.

DISCIPLINE GATE — if the brief's discipline contains "philosophy":
  STRICTLY REJECT any source whose title or venue contains pedagogy/education terms:
  teaching, classroom, pedagogy, students, curriculum, instruction, learning outcomes,
  mathematics education, science education, K-12, higher education teaching

AMBIGUOUS-WORD RULE — these words have multiple meanings; only accept if context confirms the philosophical sense:
  - "constructivism": ACCEPT if paired with Platonism/realism/ontology; REJECT if paired with classroom/teaching
  - "realism": ACCEPT if paired with mathematics/Platonism/ontology; REJECT if paired with art/literature
  - "formalism": ACCEPT if paired with mathematics/logic/Hilbert; REJECT if paired with art/literature
` : `
ESSAY TOPIC SUMMARY (first 800 chars):
"${originalText.substring(0, 800)}"
`;

            const prompt = `You are filtering search results for an academic essay.

 ${briefContext}

SEARCH RESULTS:
 ${summaries}

TASK: Return ONLY the index numbers of results that satisfy ALL of:
1. ACADEMIC in nature (peer-reviewed paper, journal article, scholarly book chapter)
2. DIRECTLY ENGAGES with the essay's central question — NOT merely shares a keyword
3. PASSES the DISCIPLINE GATE above (reject pedagogy/education papers if philosophical essay)
4. PASSES the AMBIGUOUS-WORD RULE above

STRICTLY EXCLUDE:
- Pure-math / pure-science papers that use a keyword but don't discuss philosophical implications
- Pedagogy / education papers
- Dictionary / encyclopedia entries, book reviews
- Commercial sites, blogs, forum threads

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

            // ── THE FIX: MINIMUM THRESHOLD ──
            if (filtered.length >= MINIMUM_RESULTS) {
                return filtered;
            }

            // If Groq was too strict, fill the gap with top-scored results
            if (filtered.length > 0 && filtered.length < MINIMUM_RESULTS) {
                console.log(`[Search] Groq filtered too aggressively (${filtered.length}/${MINIMUM_RESULTS}), falling back to top-scored`);
                const approvedIds = new Set(filtered.map(f => f.link));
                const fillers = results
                    .filter(r => !approvedIds.has(r.link))
                    .slice(0, MINIMUM_RESULTS - filtered.length);
                return [...filtered, ...fillers];
            }

            // If Groq returned nothing, just return top results
            return results.slice(0, MINIMUM_RESULTS);

        } catch (e) {
            if (stage) { stage.ms = Date.now() - start; stage.failures += 1; }
            console.error('[Search] Relevance filter failed:', e.message);
            return results.slice(0, MINIMUM_RESULTS);
        }
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 8: UTILITIES & HELPERS
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Initializes a fresh stats object per search() call.
     */
    _createStats() {
        return {
            startedAt: null,
            finishedAt: null,
            elapsedMs: 0,
            queriesGenerated: 0,
            stages: {
                topicAnalysis: { calls: 0, failures: 0, ms: 0, ok: false },
                openalex: { calls: 0, failures: 0, ms: 0, resultsReturned: 0 },
                filter: { calls: 0, failures: 0, ms: 0, ok: false }
            },
            results: { raw: 0, afterScoring: 0, afterFilter: 0 },
            totals: { externalRequests: 0, groqCalls: 0, httpRequests: 0, failedRequests: 0, successRate: 1 }
        };
    }
};
