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

const MINIMUM_RESULTS = 8;

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

        // Stage 3: Fetch from OpenAlex (Multiple queries)
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
    // MODULE 3: STAGE 1 - TOPIC ANALYSIS (DISCIPLINE-LOCKED)
    // ════════════════════════════════════════════════════════════════════════

    async _analyzeTopic(text, groqKey, stats) {
        const stage = stats.stages.topicAnalysis;
        stage.calls += 1;
        stats.totals.groqCalls += 1;
        const start = Date.now();

        try {
            const prompt = `You are generating search queries for an academic database. You MUST prevent "topic drift" into wrong disciplines.

ESSAY TEXT:
"${text.substring(0, 2000)}"

TASK: Return a JSON object:
{
  "discipline_prefix": "The exact academic discipline in 2-4 words. e.g., 'philosophy of mathematics', 'sociology of education', 'cognitive psychology'. This will be prepended to EVERY query.",
  "central_question": "the specific question the essay asks",
  "must_engage_with": ["3-6 short phrases capturing core claims"],
  "queries": [
    "5-8 search phrases of 4-8 words. Each MUST start exactly with the discipline_prefix followed by a specific topic."
  ]
}

CRITICAL ANTI-DRIFT RULES:
1. If the essay is about the philosophy of math, the discipline_prefix MUST be "philosophy of mathematics". It CANNOT be just "mathematics" (which returns pure math/CS papers).
2. Every single query MUST begin with the exact discipline_prefix. 
   - BAD: "invention versus discovery mathematical Platonism" (Will return CS papers)
   - GOOD: "philosophy of mathematics invention versus discovery" (Locks to philosophy)
3. Do NOT include author names.

Return ONLY raw JSON.`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON object');

            const brief = JSON.parse(jsonMatch[0]);
            stage.ms = Date.now() - start;
            stage.ok = true;

            // Hard validate that queries actually start with the discipline
            const prefix = brief.discipline_prefix?.toLowerCase() || '';
            if (!prefix) throw new Error('Missing discipline_prefix');

            brief.queries = brief.queries
                .filter(q => typeof q === 'string')
                .map(q => {
                    let clean = q.trim().substring(0, 150);
                    // Force prepend if Groq forgot
                    if (!clean.toLowerCase().startsWith(prefix)) {
                        clean = `${brief.discipline_prefix} ${clean}`;
                    }
                    return clean;
                })
                .filter(q => { const wc = q.split(/\s+/).length; return wc >= 5 && wc <= 10; })
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
        const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
        const meaningful = [...new Set(words)].slice(0, 4);
        return (meaningful.join(' ') || 'education research') + ' academic study';
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 5: STAGE 3 - DATA ACQUISITION
    // ════════════════════════════════════════════════════════════════════════

    async _searchOpenAlex(queries, stats) {
        const allResults = [];
        const stage = stats.stages.openalex;

        await Promise.all(queries.map(async (query) => {
            const start = Date.now();
            stage.calls += 1;
            stats.totals.httpRequests += 1;
            try {
                const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=15&filter=is_oa:true,has_abstract:true,type:article&mailto=research@example.com`;
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

                    // ── THE FIX: Skip papers with completely missing metadata ──
                    if (!work.title || !link || (!authors && !work.publication_year)) continue;

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
                stage.resultsReturned += (data.results || []).length;
            } catch (e) {
                stage.ms += Date.now() - start;
                stage.failures += 1;
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
        return positions.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' ').substring(0, 300);
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 6: STAGE 4 - SCORING & DEDUPLICATION
    // ════════════════════════════════════════════════════════════════════════

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
            .slice(0, 30); // Feed top 30 to Groq
    },

     // ════════════════════════════════════════════════════════════════════════
    // MODULE 7: STAGE 5 - AI RELEVANCE FILTERING (STRUCTURED JSON RERANKER)
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
            // Implementing the "Hard Structured Input" from the pasted analysis
            const structuredInput = results.map((r, i) => ({
                id: i,
                title: r.title,
                abstract: r.snippet || 'No abstract',
                venue: r.venue
            }));

            const jsonPayload = JSON.stringify(structuredInput, null, 1);

            const briefContext = brief ? `
DISCIPLINE: ${brief.discipline_prefix || 'Unknown'}
CENTRAL QUESTION: ${brief.central_question || '(unspecified)'}
MUST ENGAGE WITH: ${JSON.stringify(brief.must_engage_with || [])}
` : `
ESSAY TOPIC:
"${originalText.substring(0, 800)}"
`;

            // Implementing the "Explicit Competition Frame" from the pasted analysis
            const prompt = `You are a strict academic search reranker. 

CONTEXT:
 ${briefContext}

INPUT DATA (Array of papers):
 ${jsonPayload}

TASK:
Compare all papers against each other. Identify the papers that have drifted into the wrong academic discipline or do not directly answer the central question.

Return ONLY a raw JSON array of the "id" numbers of the papers to DELETE.
Examples:
[0, 4, 12]`;

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
                console.log(`[Search] Groq deleted too many (${filtered.length}/${MINIMUM_RESULTS}), restoring fillers`);
                const keptIndices = new Set(filtered.map((_, i) => results.indexOf(_))); 
                const fillers = results
                    .map((r, i) => ({ r, i }))
                    .filter(({ i }) => !indicesToDelete.has(i))
                    .filter(({ r }) => !filtered.includes(r))
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
