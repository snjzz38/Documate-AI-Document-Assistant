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
    // MODULE 7: STAGE 5 - AI RELEVANCE FILTERING (BULLETPROOF INTEGER INDEXES)
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
            // ── THE FIX: Use simple integer indexes. LLMs never mess this up. ──
            const summaries = results.map((r, i) => {
                const absText = r.snippet || 'No abstract available';
                return `[${i}] "${r.title}" - ${absText}`;
            }).join('\n\n');

            const briefContext = brief ? `
GROUND TRUTH:
- Central question: ${brief.central_question || '(unspecified)'}
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
1. HISTORICAL ONLY (describes history without contributing to the research question)
2. PEDAGOGY / EDUCATION (focuses on teaching, classrooms, student learning, curriculum)
3. TECHNICAL BUT IRRELEVANT (uses topic terminology but solves a different problem)
4. TANGENTIAL KEYWORD MATCH (shares keywords but addresses a different subject)
5. LOW RELEVANCE (does not directly help answer the research question)

DO NOT delete papers that directly address the central question, present competing theories, or provide relevant empirical/philosophical analysis.

Be conservative. Assume most are relevant. Delete only clear outliers.

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
                console.log(`[Search] Groq deleted too many (${filtered.length}/${MINIMUM_RESULTS}), restoring fillers`);
                const keptIndices = new Set(filtered.map((_, i) => results.indexOf(_))); 
                // Simpler filler logic since we use array indexes now
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
