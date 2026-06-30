// ==========================================================================
// FILE PATH: api/_utils/googleSearch.js
// ==========================================================================

/*
 * TABLE OF CONTENTS
 * -------------------------------------------------------
 * 1. CONFIGURATION & CONSTANTS
 * 2. CORE INTERFACE
 * 3. STAGE 1: TOPIC ANALYSIS (Generates 1 Master Query)
 * 4. STAGE 2: QUERY GENERATION (Fallback)
 * 5. STAGE 3: DATA ACQUISITION (1 OpenAlex Call, OA + Abstract Filtered)
 * 6. STAGE 4: DEDUPLICATION (Simple URL/Title matching, NO harsh scoring)
 * 7. STAGE 5: AI SOURCE SELECTION (Asks Groq to pick the best 8)
 * 8. UTILITIES & HELPERS
 */

import { GroqAPI } from './groqAPI.js';

// ════════════════════════════════════════════════════════════════════════════
// MODULE 1: CONFIGURATION & CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const MINIMUM_RESULTS = 8; // We strictly want 8 sources

// ════════════════════════════════════════════════════════════════════════════
// MODULE 2: CORE INTERFACE
// ════════════════════════════════════════════════════════════════════════════

export const GoogleSearchAPI = {

    async search(query, apiKey, cx, groqKey = null) {
        const stats = this._createStats();
        stats.startedAt = Date.now();

        // Stage 1: Generate 1 Master Query
        let masterQuery = null;
        if (groqKey) {
            const brief = await this._analyzeTopic(query, groqKey, stats);
            masterQuery = brief?.master_search_query || null;
        }
        
        if (!masterQuery) {
            masterQuery = this._buildFallbackQuery(query);
        }
        stats.queriesGenerated = 1; // Strictly 1 query

        // Stage 3: Fetch from OpenAlex (1 call)
        const openAlexResults = await this._searchOpenAlex(masterQuery, stats);
        stats.results.raw = openAlexResults.length;

        // Stage 4: Simple Deduplication (No scoring)
        const uniqueResults = this._deduplicate(openAlexResults);
        stats.results.afterScoring = uniqueResults.length;

        // Stage 5: AI Source Selection (Pick exactly 8)
        const finalResults = await this._selectBestSources(uniqueResults, query, groqKey, stats);
        stats.results.afterFilter = finalResults.length;

        // Finalize Stats
        stats.finishedAt = Date.now();
        stats.elapsedMs = stats.finishedAt - stats.startedAt;
        stats.totals.externalRequests = stats.totals.groqCalls + stats.totals.httpRequests;
        stats.totals.failedRequests = stats.stages.topicAnalysis.failures + stats.stages.openalex.failures + stats.stages.filter.failures;
        stats.totals.successRate = stats.totals.externalRequests > 0 ? +(1 - stats.totals.failedRequests / stats.totals.externalRequests).toFixed(3) : 1;

        Object.defineProperty(finalResults, 'stats', { value: stats, enumerable: false, writable: false });

        return finalResults;
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
            const prompt = `You are analyzing a student essay to prepare a search query for an academic database.

ESSAY TEXT:
"${text.substring(0, 2500)}"

TASK: Return a JSON object with this field:
{
  "master_search_query": "A SINGLE, highly optimized search string of 6-12 words designed to fetch the exact academic papers needed. Combine the central question with the discipline. Example: 'philosophy of mathematics invention versus discovery Platonism'"
}

CRITICAL RULES FOR master_search_query:
1. It must be a single natural language phrase, NOT a list of keywords.
2. It must explicitly state the discipline (e.g., "philosophy of...", "sociology of...").
3. It should be the kind of phrase that appears in the title or abstract of a perfect academic paper.
4. Do NOT include author names unless absolutely necessary for disambiguation.

Return ONLY the raw JSON object, no markdown.`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON object');

            const brief = JSON.parse(jsonMatch[0]);
            stage.ms = Date.now() - start;
            stage.ok = true;

            if (!brief.master_search_query || brief.master_search_query.length < 5) {
                throw new Error('Invalid query');
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

    _buildFallbackQuery(text) {
        const words = text.toLowerCase().match(/\b[a-z]{5,}\b/g) || [];
        const meaningful = [...new Set(words)].slice(0, 4);
        return (meaningful.join(' ') || 'academic research') + ' academic study';
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 5: STAGE 3 - DATA ACQUISITION
    // ════════════════════════════════════════════════════════════════════════

    async _searchOpenAlex(masterQuery, stats) {
        const stage = stats.stages.openalex;
        stage.calls += 1;
        stats.totals.httpRequests += 1;
        const start = Date.now();
        const allResults = [];

        try {
            // is_oa:true (No paywalls), has_abstract:true (Guarantees snippet), type:article (No book chapters)
            const url = `https://api.openalex.org/works?search=${encodeURIComponent(masterQuery)}&per-page=20&filter=is_oa:true,has_abstract:true,type:article&mailto=research@example.com`;
            
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

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
                    snippet: abstract, 
                    authors,
                    year: work.publication_year,
                    venue: work.primary_location?.source?.display_name || '',
                    source: 'openalex'
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

    _reconstructAbstract(invertedIndex) {
        if (!invertedIndex || typeof invertedIndex !== 'object') return '';
        const positions = [];
        for (const [word, idxs] of Object.entries(invertedIndex)) {
            for (const i of idxs) positions.push([i, word]);
        }
        return positions.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' ').substring(0, 300);
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 6: STAGE 4 - DEDUPLICATION (NO SCORING)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Simply removes exact duplicate URLs or Titles. 
     * We let Groq handle all actual relevance logic.
     */
    _deduplicate(results) {
        const seenUrls = new Set();
        const seenTitles = new Set();

        return results.filter(r => {
            if (!r.title || !r.link) return false;
            
            const lowerUrl = r.link.toLowerCase();
            const normalizedTitle = r.title.toLowerCase().substring(0, 60).trim();

            if (seenUrls.has(lowerUrl)) return false;
            if (seenTitles.has(normalizedTitle)) return false;

            seenUrls.add(lowerUrl);
            seenTitles.add(normalizedTitle);
            return true;
        }).slice(0, 20); // Pass up to 20 to Groq to pick from
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 7: STAGE 5 - AI SOURCE SELECTION
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Asks Groq to positively select the best 8 papers.
     */
    async _selectBestSources(results, originalText, groqKey, stats) {
        const stage = stats ? stats.stages.filter : null;
        if (stage) { stage.calls += 1; stats.totals.groqCalls += 1; }
        const start = stats ? Date.now() : 0;

        if (!groqKey || results.length === 0) {
            if (stage) { stage.ms = Date.now() - start; stage.ok = true; }
            return results.slice(0, MINIMUM_RESULTS);
        }

        const getCitationKey = (r) => `${r.authors || 'Unknown'} (${r.year || 'n.d.'}). ${r.title}. ${r.venue}`;

        try {
            const citationMap = {};
            results.forEach((r, i) => {
                citationMap[i] = {
                    citation: getCitationKey(r),
                    abstract: r.snippet || 'No abstract available'
                };
            });
            
            const jsonPayload = JSON.stringify(citationMap, null, 2);

            const prompt = `You are an expert academic researcher. You are given a list of academic papers with their abstracts. 

RESEARCH TOPIC:
"${originalText.substring(0, 800)}"

PAPERS:
 ${jsonPayload}

TASK:
Carefully read the abstracts and select the EXACTLY ${MINIMUM_RESULTS} BEST papers that directly engage with the research topic. 

Prioritize papers that:
1. Directly debate, analyze, or provide evidence for the central question.
2. Present competing theories or conceptual frameworks.
3. Are strictly academic (ignore pedagogy/teaching papers unless strictly relevant).

Return ONLY a raw JSON array of the index numbers of the best papers. 
You MUST return exactly ${MINIMUM_RESULTS} indexes.
Example: [0, 2, 5, 7, 11, 14, 18, 19]`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            if (stage) stage.ms = Date.now() - start;
            
            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) throw new Error('No JSON array');

            const selectedIndexes = JSON.parse(jsonMatch[0]);
            
            if (!Array.isArray(selectedIndexes) || selectedIndexes.length === 0) {
                throw new Error('Empty array');
            }

            // Map selected indexes back to results
            let filtered = selectedIndexes
                .filter(i => typeof i === 'number' && i >= 0 && i < results.length)
                .map(i => results[i]);

            if (stage) stage.ok = true;

            // If Groq gave us some but not enough, fill the rest from the top
            if (filtered.length < MINIMUM_RESULTS) {
                console.log(`[Search] Groq only selected ${filtered.length}, padding with remaining`);
                const keptIndexes = new Set(selectedIndexes);
                const fillers = results
                    .map((r, i) => ({ r, i }))
                    .filter(({ i }) => !keptIndexes.has(i))
                    .map(({ r }) => r);
                
                filtered = [...filtered, ...fillers].slice(0, MINIMUM_RESULTS);
            }

            return filtered;

        } catch (e) {
            if (stage) { stage.ms = Date.now() - start; stage.failures += 1; }
            console.error('[Search] Source selection failed:', e.message);
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
