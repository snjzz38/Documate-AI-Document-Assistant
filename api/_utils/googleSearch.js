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

        // Stage 2: Generate Master Query
        const masterQuery = brief ? brief.master_search_query : this._buildFallbackQuery(query);
        stats.queriesGenerated = 1; // Changed from queries.length

        // Stage 3: Fetch from OpenAlex (1 call)
        const openAlexResults = await this._searchOpenAlex(masterQuery, stats); // Pass string, not array
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
    // MODULE 3: STAGE 1 - TOPIC ANALYSIS (Updated for 1 Master Query)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Uses Groq to read the essay and create a single, highly-optimized search query.
     */
    async _analyzeTopic(text, groqKey, stats) {
        const stage = stats.stages.topicAnalysis;
        stage.calls += 1;
        stats.totals.groqCalls += 1;
        const start = Date.now();

        try {
            const prompt = `You are analyzing a student essay to prepare a search query for an academic database (OpenAlex).

ESSAY TEXT:
"${text.substring(0, 2500)}"

TASK: Analyze the essay and return a JSON object with these fields:

{
  "central_question": "the specific question the essay is trying to answer",
  "must_engage_with": ["3-6 short PHRASES that capture the essay's core claims — e.g., 'mathematics as invention or discovery'"],
  "master_search_query": "A SINGLE, highly optimized search string of 6-12 words designed to fetch the exact academic papers needed. Combine the central question with the discipline. Example: 'philosophy of mathematics invention versus discovery Platonism'"
}

CRITICAL RULES FOR master_search_query:
1. It must be a single natural language phrase, NOT a list of keywords.
2. It must explicitly state the discipline (e.g., "philosophy of...", "sociology of...").
3. It should be the kind of phrase that appears in the title or abstract of a perfect academic paper.

Return ONLY the raw JSON object, no markdown.`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON object in response');

            const brief = JSON.parse(jsonMatch[0]);
            stage.ms = Date.now() - start;
            stage.ok = true;

            if (!brief.master_search_query || brief.master_search_query.length < 5) {
                throw new Error('No valid master query');
            }

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
    // MODULE 5: STAGE 3 - DATA ACQUISITION (1 Call, Filtered at Source)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Makes exactly 1 call to OpenAlex.
     * Filters for Open Access AND Has Abstract to guarantee clean data.
     */
    async _searchOpenAlex(masterQuery, stats) {
        const stage = stats.stages.openalex;
        stage.calls += 1;
        stats.totals.httpRequests += 1;
        const start = Date.now();
        const allResults = [];

        try {
            // The Magic Filters: is_oa:true ensures no paywalls, has_abstract:true guarantees snippets
            const url = `https://api.openalex.org/works?search=${encodeURIComponent(masterQuery)}&per-page=30&filter=is_oa:true,has_abstract:true&mailto=research@example.com`;
            
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout for 1 large request

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
                // Truncate abstract to 300 chars right at the source
                const abstract = this._reconstructAbstract(work.abstract_inverted_index);
                const authors = (work.authorships || []).map(a => a.author?.display_name).filter(Boolean).slice(0, 3).join(', ');

                if (!work.title || !link) continue;

                allResults.push({
                    title: work.title,
                    link,
                    snippet: abstract, 
                    authors,
                    year: work.publication_year,
                    venue: work.primary_location?.source?.display_name || '',
                    source: 'openalex',
                    _score: 10
                });
            }
            stage.resultsReturned = (data.results || []).length;
        } catch (e) {
            stage.ms = Date.now() - start;
            stage.failures += 1;
            console.error('[Search] OpenAlex failed:', e.message);
        }

        return allResults;
    },

    /**
     * Truncates to 300 characters as requested.
     */
    _reconstructAbstract(invertedIndex) {
        if (!invertedIndex || typeof invertedIndex !== 'object') return '';
        const positions = [];
        for (const [word, idxs] of Object.entries(invertedIndex)) {
            for (const i of idxs) positions.push([i, word]);
        }
        return positions.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' ').substring(0, 300);
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
            .slice(0, 30); // Pass top 30 to Groq instead of 20
    },


    // ════════════════════════════════════════════════════════════════════════
    // MODULE 7: STAGE 5 - AI RELEVANCE FILTERING (JSON Key-Value Format)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Sends a JSON object {citation: abstract} and asks Groq to return the keys to delete.
     */
    async _filterByRelevance(results, originalText, groqKey, brief, stats) {
        const stage = stats ? stats.stages.filter : null;
        if (stage) { stage.calls += 1; stats.totals.groqCalls += 1; }
        const start = stats ? Date.now() : 0;

        if (!groqKey || results.length === 0) {
            if (stage) { stage.ms = Date.now() - start; stage.ok = true; }
            return results;
        }

        // Helper to generate the exact same citation string for the map and the filter
        const getCitationKey = (r) => `${r.authors || 'Unknown'} (${r.year || 'n.d.'}). ${r.title}. ${r.venue}`;

        try {
            // Build the { citation: abstract } JSON object
            const citationMap = {};
            results.forEach(r => {
                citationMap[getCitationKey(r)] = r.snippet || 'No abstract available';
            });
            
            const jsonPayload = JSON.stringify(citationMap, null, 2);

            const briefContext = brief ? `
GROUND TRUTH:
- Central question: ${brief.central_question || '(unspecified)'}
- Must engage with: ${JSON.stringify(brief.must_engage_with || [])}
` : `
ESSAY TOPIC:
"${originalText.substring(0, 800)}"
`;

            const prompt = `You are pruning an academic search results list formatted as a JSON object.

Your job is to identify the FEW outlier papers that should be removed because they are not meaningfully relevant to the research topic.

RESEARCH CONTEXT:
 ${briefContext}

SEARCH RESULTS (JSON Object where keys are citations, values are abstracts):
 ${jsonPayload}

TASK:
Identify papers that are OFF-TOPIC. Delete a paper if it falls into ANY of these categories:
1. HISTORICAL ONLY (describes history without contributing to the research question)
2. PEDAGOGY / EDUCATION (focuses on teaching, classrooms, student learning)
3. TECHNICAL BUT IRRELEVANT (uses topic terminology but solves a different problem)
4. TANGENTIAL KEYWORD MATCH (shares keywords but addresses a different subject)
5. LOW RELEVANCE (does not directly help answer the research question)

DO NOT delete papers that directly address the central question, present competing theories, or provide relevant empirical/philosophical analysis.

Be conservative. Assume most are relevant. Delete only clear outliers.

Return ONLY a raw JSON array of the EXACT citation keys to delete.
Example: ["Smith (2020). Title. Journal", "Doe (2019). Title. Journal"]`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            if (stage) stage.ms = Date.now() - start;
            
            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) throw new Error('No JSON array');

            const keysToDelete = new Set(JSON.parse(jsonMatch[0]));
            
            // Filter using the exact keys instead of flaky array indexes
            let filtered = results.filter(r => !keysToDelete.has(getCitationKey(r)));

            if (stage) stage.ok = true;

            // ── MINIMUM THRESHOLD ──
            if (filtered.length >= MINIMUM_RESULTS) {
                return filtered;
            }

            if (filtered.length < MINIMUM_RESULTS) {
                console.log(`[Search] Groq deleted too many (${filtered.length}/${MINIMUM_RESULTS}), restoring fillers`);
                const keptKeys = new Set(filtered.map(getCitationKey));
                const fillers = results
                    .filter(r => !keptKeys.has(getCitationKey(r)))
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
