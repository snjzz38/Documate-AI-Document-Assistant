// ==========================================================================
// FILE PATH: api/_utils/googleSearch.js
// ==========================================================================

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

const MINIMUM_RESULTS = 6; 

// ════════════════════════════════════════════════════════════════════════════
// MODULE 2: CORE INTERFACE
// ════════════════════════════════════════════════════════════════════════════

export const GoogleSearchAPI = {

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

        // OPTIMIZATION: We only make ONE OpenAlex call now.
        // We use the central question if available, otherwise the first generated query.
        const singleQuery = brief?.central_question || queries[0] || query;

        // Stage 3: Fetch from OpenAlex
        const openAlexResults = await this._searchOpenAlex(singleQuery, stats);
        stats.results.raw = openAlexResults.length;

        // Stage 4: Score and Deduplicate
        const scoredResults = this._filterAndScore(openAlexResults);
        stats.results.afterScoring = scoredResults.length;

        // Stage 5: AI Relevance Filter
        const relevantResults = await this._filterByRelevance(scoredResults, query, groqKey, brief, stats);
        stats.results.afterFilter = relevantResults.length;

        // Create the filtered JSON object for abstracts {citation0: abstract0, ...}
        const abstractMap = {};
        relevantResults.forEach((r, i) => {
            abstractMap[`citation${i}`] = r.snippet || '';
        });

        // Finalize Stats
        stats.finishedAt = Date.now();
        stats.elapsedMs = stats.finishedAt - stats.startedAt;
        stats.totals.externalRequests = stats.totals.groqCalls + stats.totals.httpRequests;
        stats.totals.failedRequests = stats.stages.topicAnalysis.failures + stats.stages.openalex.failures + stats.stages.filter.failures;
        stats.totals.successRate = stats.totals.externalRequests > 0 ? +(1 - stats.totals.failedRequests / stats.totals.externalRequests).toFixed(3) : 1;

        Object.defineProperty(relevantResults, 'stats', { value: stats, enumerable: false, writable: false });
        Object.defineProperty(relevantResults, 'abstractMap', { value: abstractMap, enumerable: false, writable: false });

        return relevantResults;
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 3: STAGE 1 - TOPIC ANALYSIS
    // ════════════════════════════════════════════════════════════════════════

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
  "philosophical_positions": ["list of named philosophical positions, theories, or frameworks the essay engages with"],
  "discipline": "the academic discipline this essay belongs to",
  "named_entities": [
    {"name": "specific named thing from essay", "role": "how it's used in the argument", "abstract_framing": "the philosophical claim it supports"}
  ],
  "must_engage_with": ["3-6 short PHRASES that capture the essay's core claims"],
  "queries": [
    "5-8 NATURAL SEARCH PHRASES — short, readable phrases of 4-8 words each",
    "each phrase must read like a coherent description of a specific claim or question from the essay",
    "phrases should be the kind of text likely to appear in an academic paper TITLE or ABSTRACT"
  ]
}

CRITICAL RULES:
1. ALWAYS return PHRASES, not keyword lists.
2. Each phrase must SELF-CONTEXTUALIZE.
3. The "queries" must cover EVERY distinct section/argument of the essay.
4. Each phrase must be 4-8 words.

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
     * Fetches papers from OpenAlex API.
     * OPTIMIZED: Now makes exactly ONE call using a combined query, 
     * and filters for Open Access works with abstracts.
     */
    async _searchOpenAlex(query, stats) {
        const allResults = [];
        const stage = stats.stages.openalex;
        const start = Date.now();
        
        stage.calls += 1;
        stats.totals.httpRequests += 1;

        try {
            // Single call, increased per-page to 50 to get a massive pool from one query
            const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&filter=is_oa:true,has_abstract:true&per-page=50&mailto=research@example.com`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 12000);

            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'AcademicCitationTool/1.0 (mailto:research@example.com)' }
            });
            clearTimeout(timeout);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            stage.ms = Date.now() - start;

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
            console.error('[Search] OpenAlex fetch failed:', e.message);
        }

        return allResults;
    },

    /**
     * Decodes OpenAlex's inverted index, normalizes whitespace to save tokens, 
     * and truncates to 300 characters.
     */
    _reconstructAbstract(invertedIndex) {
        if (!invertedIndex || typeof invertedIndex !== 'object') return '';
        const positions = [];
        for (const [word, idxs] of Object.entries(invertedIndex)) {
            for (const i of idxs) positions.push([i, word]);
        }
        
        // Join, normalize whitespace (collapse multiple spaces/newlines into one), and truncate to 300 chars
        return positions
            .sort((a, b) => a[0] - b[0])
            .map(p => p[1])
            .join(' ')
            .replace(/\s+/g, ' ') 
            .trim()
            .substring(0, 300);
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 6: STAGE 4 - SCORING & DEDUPLICATION
    // ════════════════════════════════════════════════════════════════════════

    _filterAndScore(results) {
        let filtered = results.filter(r => {
            const linkLower = (r.link || '').toLowerCase();
            const isBannedDomain = BANNED_DOMAINS.some(d => linkLower.includes(d));
            const isBannedExt = BANNED_EXTENSIONS.some(ext => linkLower.endsWith(ext));
            return !isBannedDomain && !isBannedExt;
        });

        const seen = new Set();
        filtered = filtered.filter(r => {
            if (!r.link || seen.has(r.link)) return false;
            seen.add(r.link);
            return true;
        });

        filtered.forEach(r => {
            let score = r._score || 0;
            const linkLower = (r.link || '').toLowerCase();
            const venueLower = (r.venue || '').toLowerCase();
            
            if (PREFERRED_DOMAINS.some(d => linkLower.includes(d) || venueLower.includes(d))) {
                score += 10;
            }
            if (r.snippet && r.snippet.length > 150) {
                score += 5;
            }
            const currentYear = new Date().getFullYear();
            if (r.year) {
                if (r.year >= currentYear - 5) score += 3;
                else if (r.year >= currentYear - 10) score += 1;
                else if (r.year < 2000) score -= 2;
            }
            r._score = score;
        });

        return filtered
            .sort((a, b) => b._score - a._score)
            .slice(0, 30);
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 7: STAGE 5 - AI RELEVANCE FILTERING
    // ════════════════════════════════════════════════════════════════════════

    async _filterByRelevance(results, originalText, groqKey, brief, stats) {
        const stage = stats ? stats.stages.filter : null;
        if (stage) { stage.calls += 1; stats.totals.groqCalls += 1; }
        const start = stats ? Date.now() : 0;

        if (!groqKey || results.length === 0) {
            if (stage) { stage.ms = Date.now() - start; stage.ok = true; }
            return results;
        }

        try {
            const summaries = results.map((r, i) => {
                const absText = r.snippet || 'No abstract available';
                return `[${i}] Title: "${r.title}"\nAbstract: ${absText}`;
            }).join('\n\n---\n\n');

            const briefContext = brief ? `
GROUND TRUTH:
- Central question: ${brief.central_question || '(unspecified)'}
- Discipline: ${brief.discipline || '(unspecified)'}
- Must engage with: ${JSON.stringify(brief.must_engage_with || [])}
` : `
ESSAY TOPIC:
"${originalText.substring(0, 800)}"
`;

            const prompt = `You are pruning an academic search results list.

Your job is to identify the FEW outlier papers that should be removed because they are not meaningfully relevant to the research topic.

RESEARCH CONTEXT:
${briefContext}

SEARCH RESULTS:
${summaries}

TASK:
Identify papers that are OFF-TOPIC and return ONLY their index numbers as a raw JSON array.

Delete a paper if it falls into ANY of these categories:

1. HISTORICAL ONLY
   - Primarily describes historical events, people, or development without contributing to the research question.

2. PEDAGOGY, TEACHING, OR EDUCATION
   - Focuses on teaching methods, curriculum, classrooms, student learning, "discovery learning", or "mathematics education".
   - CRITICAL: Delete papers about "mathematics education", "undergraduate students", "peer collaboration", or "attitudes/beliefs", EVEN IF they use philosophical words like "constructivism", "epistemology", "platonism", or "discovery" in the title or abstract. We ONLY want pure philosophy and ontology, not teaching theory or student psychology.

3. TECHNICAL BUT IRRELEVANT
   - Uses terminology related to the topic but is actually about a different technical problem or application.

4. TANGENTIAL KEYWORD MATCH
   - Appears because of shared keywords but addresses a substantially different subject.

5. BOOK REVIEW OR EDITORIAL
   - Reviews another work or contains commentary without making a substantive contribution to the research question.

6. LOW RELEVANCE
   - The paper does not directly help answer the research question described in the context.

DO NOT delete papers that:
- Directly address the central research question.
- Present competing theories, perspectives, or conceptual frameworks relevant to the topic.
- Provide empirical evidence, philosophical analysis, theoretical models, or systematic reviews that are useful for answering the research question.

Be conservative. Assume most search results are relevant. Delete only clear outliers.

Return ONLY a raw JSON array of index numbers.
Examples:
[]
[3]
[2, 7, 15]`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            if (stage) stage.ms = Date.now() - start;
            
            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) throw new Error('No JSON array');

            const indicesToDelete = new Set(JSON.parse(jsonMatch[0]));
            let filtered = results.filter((_, index) => !indicesToDelete.has(index));

            if (stage) stage.ok = true;

            if (filtered.length >= MINIMUM_RESULTS) {
                return filtered;
            }

            if (filtered.length < MINIMUM_RESULTS) {
                console.log(`[Search] Groq deleted too many (${filtered.length}/${MINIMUM_RESULTS}), restoring top-scored fillers`);
                const keptLinks = new Set(filtered.map(f => f.link));
                
                const fillers = results
                    .map((r, index) => ({ r, index }))
                    .filter(({ r, index }) => !keptLinks.has(r.link) && !indicesToDelete.has(index))
                    .map(({ r }) => r)
                    .slice(0, MINIMUM_RESULTS - filtered.length);
                    
                return [...filtered, ...fillers];
            }

            return filtered;

        } catch (e) {
            if (stage) { stage.ms = Date.now() - start; stage.failures += 1; }
            console.error('[Search] Relevance filter failed:', e.message);
            return results.slice(0, MINIMUM_RESULTS);
        }
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 8: UTILITIES & HELPERS
    // ════════════════════════════════════════════════════════════════════════

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
