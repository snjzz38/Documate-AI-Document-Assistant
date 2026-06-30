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

// Updated to 8 as requested
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

        // OPTIMIZATION: We only make ONE OpenAlex call now.
        const singleQuery = queries[0] || brief?.central_question || query;

        // Stage 3: Fetch from OpenAlex
        const openAlexResults = await this._searchOpenAlex(singleQuery, stats);
        stats.results.raw = openAlexResults.length;

        // Stage 4: Score and Deduplicate (Relaxed scoring)
        const scoredResults = this._filterAndScore(openAlexResults);
        stats.results.afterScoring = scoredResults.length;

        // Stage 5: AI Relevance Filter (Now explicitly asks for 8 sources)
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
           const prompt = `You are analyzing a student essay to generate a HIGH-PRECISION academic search brief for retrieving relevant scholarly sources across ANY discipline.

Your goal is to extract the true research intent of the essay in a way that produces tightly relevant, high-quality academic search queries while minimizing noise, tangential results, and keyword-matching errors.

ESSAY TEXT:
"${text.substring(0, 2500)}"

OUTPUT FORMAT (return ONLY valid JSON):

{
  "core_thesis": "one-sentence summary of the essay's main claim or argument",
  
  "central_question": "the single most important question the essay is trying to answer",

  "discipline": "primary academic field(s), inferred broadly (e.g. physics, psychology, economics, philosophy, computer science, sociology, biology, engineering, education)",

  "key_concepts": [
    "core ideas, theories, models, or mechanisms essential to the essay",
    "only include concepts that are necessary to understand or evaluate the argument"
  ],

  "named_entities": [
    {
      "name": "specific theory, model, author, method, dataset, or principle explicitly used",
      "role": "why it matters in the argument",
      "interpretation": "how the essay uses or frames it"
    }
  ],

  "must_engage_with": [
    "3–6 essential claims that define what a relevant academic source MUST address",
    "these should represent evaluative or explanatory requirements, not surface topics"
  ],

  "queries": [
    "5–8 HIGH-QUALITY academic search phrases",
    "each phrase must be 5–10 words",
    "each phrase must describe a specific research problem, mechanism, or debate",
    "each phrase must be suitable as a paper title or abstract sentence fragment",
    "each phrase must be semantically specific (NOT keyword lists)"
  ]
}

STRICT RELEVANCE RULES (CRITICAL):

1. PRIORITIZE SEMANTIC RELEVANCE OVER KEYWORDS
   - Do NOT match words; match ideas, mechanisms, and claims.

2. EACH QUERY MUST TARGET:
   - a causal explanation, OR
   - a theoretical model, OR
   - a measurable phenomenon, OR
   - a methodological approach, OR
   - a formal debate in the field

3. EXCLUDE GENERIC OR BROAD PHRASES SUCH AS:
   - "introduction to X"
   - "overview of X"
   - "history of X"
   - "basic concepts of X"

4. ONLY INCLUDE BACKGROUND TOPICS IF THEY ARE ESSENTIAL TO THE ARGUMENT.

5. QUERIES MUST BE TIGHTLY FOCUSED:
   - If a query would retrieve textbooks, surveys, or general education materials, it is TOO BROAD.

6. OPTIMIZE FOR ACADEMIC DATABASE RETRIEVAL:
   - Prefer phrases that would appear in journal titles, abstracts, or theoretical sections of papers.

7. DISCIPLINE FLEXIBILITY RULE:
   - Adapt all outputs to the essay's domain.
   - Do NOT assume philosophy unless explicitly present.
   - Works equally for STEM, social sciences, humanities, and applied fields.

OUTPUT RULES:
- Return ONLY valid JSON.
- No commentary, no markdown.
- All fields must be filled; if uncertain, choose the most precise plausible interpretation.

CRITICAL DOMAIN CONSISTENCY RULE:

All selected papers MUST belong to the same general research domain and problem space as the essay.

Do NOT select:
- high-quality papers from unrelated disciplines
- general theoretical frameworks not used in the essay’s field
- “famous” methods or theories unless directly applicable

A paper is ONLY valid if it:
- addresses the same type of system, phenomenon, or problem
- OR uses a method directly applicable to the essay’s argument
- OR is explicitly used as a comparative/contrasting framework in the essay
`;
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

    async _searchOpenAlex(query, stats) {
        const allResults = [];
        const stage = stats.stages.openalex;
        const start = Date.now();
        
        stage.calls += 1;
        stats.totals.httpRequests += 1;

        try {
            // Single call, 50 results, sorted by most cited, strict OA + abstract filters
            const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&filter=has_abstract:true,is_oa:true&sort=cited_by_count:desc&per-page=50&mailto=research@example.com`;
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
                // Client-side safety check to ensure we have an abstract and it's actually OA
                if (!work.abstract_inverted_index || work.open_access?.is_oa !== true) continue;

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
            .replace(/\s+/g, ' ') 
            .trim()
            .substring(0, 300);
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 6: STAGE 4 - SCORING & DEDUPLICATION (RELAXED)
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
            
            // Boost preferred academic domains
            if (PREFERRED_DOMAINS.some(d => linkLower.includes(d) || venueLower.includes(d))) {
                score += 10;
            }
            
            // Boost papers with substantial abstracts
            if (r.snippet && r.snippet.length > 150) {
                score += 5;
            }
            
            // Recency bonus (NO PENALTY FOR OLD PAPERS - crucial for philosophy!)
            const currentYear = new Date().getFullYear();
            if (r.year) {
                if (r.year >= currentYear - 5) score += 3;
                else if (r.year >= currentYear - 10) score += 1;
                // REMOVED: else if (r.year < 2000) score -= 2;
            }

            r._score = score;
        });

        // Pass top 30 to Groq
        return filtered
            .sort((a, b) => b._score - a._score)
            .slice(0, 30);
    },

    // ════════════════════════════════════════════════════════════════════════
    // MODULE 7: STAGE 5 - AI RELEVANCE FILTERING (STRICT SELECTION)
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
- Core thesis: ${brief.core_thesis || '(unspecified)'}
- Discipline: ${brief.discipline || '(unspecified)'}
- Must engage with: ${JSON.stringify(brief.must_engage_with || [])}
` : `
ESSAY TOPIC:
"${originalText.substring(0, 800)}"
`;

            const targetCount = Math.min(8, results.length);

const prompt = `You are an expert academic research assistant.

Your task is to select the EXACTLY ${targetCount} MOST USEFUL academic papers for writing a strong student essay based on the provided research context.

RESEARCH CONTEXT:
${briefContext}

SEARCH RESULTS:
${summaries}

TASK:
Select the ${targetCount} papers that provide the HIGHEST RESEARCH VALUE for writing the essay.

Return ONLY their index numbers as a raw JSON array of exactly ${targetCount} integers.

SELECTION PRINCIPLE (CRITICAL):
Choose papers based on how useful they are for constructing, supporting, or critically evaluating the essay's argument — NOT based on keywords or surface topic similarity.

A good paper:
- Helps explain a core concept in the essay
- Provides a theoretical framework or model
- Offers empirical evidence or formal analysis relevant to the argument
- Engages directly with the same research question or problem structure
- Represents a key position in an ongoing academic debate relevant to the essay

A bad paper:
- Matches keywords but addresses a different problem
- Is purely historical or descriptive without analytical contribution
- Is about education, teaching methods, or pedagogy (unless the essay is about education)
- Is a general overview or textbook-style summary
- Is only loosely related through terminology overlap

SELECTION RULES:

1. STRICT RELEVANCE:
   Every selected paper must directly improve the student's ability to write or defend the essay.

2. DIVERSITY OF UTILITY:
   Prefer a balanced set if applicable:
   - theoretical frameworks
   - empirical studies
   - critical/contrasting perspectives
   - foundational or highly influential works

3. AVOID REDUNDANCY:
   Do not select multiple papers that make the same argument unless necessary.

4. DISCIPLINE-AWARENESS:
   Adapt to the essay's field automatically (do NOT assume philosophy or any fixed domain).

5. HARD CONSTRAINT:
   You MUST return exactly ${targetCount} indices.

6. BE STRICT:
   If a paper is only weakly relevant, exclude it even if it shares keywords.

OUTPUT FORMAT:
Return ONLY a JSON array of exactly ${targetCount} index numbers.

CRITICAL DOMAIN CONSISTENCY RULE:

All selected papers MUST belong to the same general research domain and problem space as the essay.

Do NOT select:
- high-quality papers from unrelated disciplines
- general theoretical frameworks not used in the essay’s field
- “famous” methods or theories unless directly applicable

A paper is ONLY valid if it:
- addresses the same type of system, phenomenon, or problem
- OR uses a method directly applicable to the essay’s argument
- OR is explicitly used as a comparative/contrasting framework in the essay

Example:
[0, 2, 5, 7, 12, 15, 18, 21]`;

            const response = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
            if (stage) stage.ms = Date.now() - start;
            
            const jsonMatch = response.match(/\[[\s\S]*?\]/);
            if (!jsonMatch) throw new Error('No JSON array');

            const selectedIndices = new Set(JSON.parse(jsonMatch[0]));
            let filtered = results.filter((_, index) => selectedIndices.has(index));

            if (stage) stage.ok = true;

            if (filtered.length >= targetCount) {
                return filtered.slice(0, targetCount);
            }

            if (filtered.length < targetCount) {
                console.log(`[Search] Groq returned too few (${filtered.length}/${targetCount}), restoring top-scored fillers`);
                const keptLinks = new Set(filtered.map(f => f.link));
                
                const fillers = results
                    .map((r, index) => ({ r, index }))
                    .filter(({ r, index }) => !keptLinks.has(r.link) && !selectedIndices.has(index))
                    .map(({ r }) => r)
                    .slice(0, targetCount - filtered.length);
                    
                return [...filtered, ...fillers];
            }

            return filtered;

        } catch (e) {
            if (stage) { stage.ms = Date.now() - start; stage.failures += 1; }
            console.error('[Search] Relevance filter failed:', e.message);
            return results.slice(0, Math.min(8, results.length));
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
