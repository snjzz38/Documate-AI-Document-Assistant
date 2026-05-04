// api/utils/googleSearch.js
// Academic Source Pipeline — Single-File, LLM-Driven (v6)
// Flow: Generate Queries → Fetch SearXNG → (Optional Scraper) → LLM Filter → Final JSON
// Zero hardcoded lists. All logic contained in one export with internal modules.

import { GroqAPI } from './groqAPI.js';

// ─── Internal Configuration ─────────────────────────────────────────────────
const _CFG = {
  instances: [
    'https://priv.au', 'https://search.sapti.me', 'https://searx.tiekoetter.com',
    'https://search.bus-hit.me', 'https://searx.be', 'https://search.ononoki.org',
    'https://searxng.site', 'https://paulgo.io',
  ],
  timeout: 8000,
  maxResultsPerQuery: 15,
  maxTotalResults: 30,
};

export const GoogleSearchAPI = {
  // ─── MODULE 1: Pipeline Orchestrator ──────────────────────────────────────
  /**
   * Main entry point. Runs the exact pipeline you specified.
   * @param {string} essay - Line of inquiry / essay text
   * @param {string} groqKey - Required for LLM steps
   * @param {object} opts - { timeRange?: string, useScraper?: boolean }
   * @returns {Promise<Object>} { kept_sources: [...] }
   */
  async run(essay, groqKey, opts = {}) {
    if (!groqKey) throw new Error('Groq API key is required for LLM pipeline');
    const { timeRange = null, useScraper = false } = opts;

    try {
      // 1. Generate 2-3 targeted search sentences
      const queries = await this._generateQueries(essay, groqKey);
      console.log('[Pipeline] Generated queries:', queries);

      // 2. Fetch raw results from SearXNG
      const rawResults = await this._fetchAll(queries, { timeRange });
      console.log(`[Pipeline] Fetched ${rawResults.length} raw results`);
      if (rawResults.length === 0) throw new Error('No search results. The search service may be temporarily unavailable.');

      // 3. Optional Scraper enrichment
      let enriched = rawResults;
      if (useScraper) {
        try { enriched = await this._enrichWithScraper(rawResults); }
        catch (e) { console.warn('[Pipeline] Scraper enrichment failed:', e.message); }
      }

      // 4. LLM filters to final JSON & returns
      return await this._llmFilter(enriched, essay, groqKey);

    } catch (err) {
      console.error('[Pipeline] Fatal:', err.message);
      throw err; // Let your connector handle it
    }
  },

  // ─── MODULE 2: Query Generation ───────────────────────────────────────────
  async _generateQueries(essay, groqKey) {
    const prompt = `You are an academic research assistant. Generate exactly 2-3 targeted search queries to find scholarly sources that directly support or inform the argument below.

ESSAY / LINE OF INQUIRY:
"""
${essay.substring(0, 1000)}
"""

RULES:
- Each query must be a complete, academic-style sentence or phrase (6-12 words)
- Focus on key claims, themes, devices, or evidence mentioned in the text
- Do NOT generate generic or overly broad queries
- Return ONLY a raw JSON array of strings, e.g. ["query one", "query two"]`;

    try {
      const res = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
      const match = res.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('Invalid JSON format');
      const queries = JSON.parse(match[0]);
      if (!Array.isArray(queries) || queries.length === 0) throw new Error('Empty array');
      return queries.slice(0, 3).map(q => q.trim().substring(0, 150));
    } catch (e) {
      console.warn('[Pipeline] Query gen failed, using fallback:', e.message);
      const sentences = essay.match(/[^.!?]+[.!?]+/g) || [essay];
      return sentences.slice(0, 2).map(s => s.trim().substring(0, 100));
    }
  },

  // ─── MODULE 3: SearXNG Fetcher ────────────────────────────────────────────
  async _fetchAll(queries, { timeRange }) {
    const allResults = [];
    const seenLinks = new Set();

    for (const query of queries) {
      for (const instance of _CFG.instances) {
        try {
          const batch = await this._fetchInstance(instance, query, { timeRange });
          for (const r of batch) {
            if (r.link && !seenLinks.has(r.link) && allResults.length < _CFG.maxTotalResults) {
              allResults.push(r);
              seenLinks.add(r.link);
            }
          }
          if (batch.length > 3) break; // Found a working instance for this query
        } catch { continue; }
      }
    }
    return allResults;
  },

  async _fetchInstance(instanceUrl, query, { timeRange }) {
    const params = new URLSearchParams({
      q: query, format: 'json', categories: 'general,science',
      language: 'en', engines: 'google,bing,duckduckgo,brave,semantic_scholar,crossref',
      ...(timeRange && { time_range: timeRange }),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), _CFG.timeout);

    try {
      const res = await fetch(`${instanceUrl}/search?${params}`, {
        signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Instance returned HTML');

      const data = await res.json();
      if (!Array.isArray(data.results)) throw new Error('No results array');

      return data.results.slice(0, _CFG.maxResultsPerQuery)
        .filter(r => r.url && r.title)
        .map(r => ({ title: r.title, link: r.url, snippet: r.content || r.snippet || '', engine: r.engine || '' }));
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  },

  // ─── MODULE 4: Scraper Enrichment (Inline) ────────────────────────────────
  async _enrichWithScraper(results) {
    // If you revert your original scraper, just replace this line:
    // return await ScraperAPI.scrape(results);
    
    // Lightweight inline version to keep single-file integrity:
    return await Promise.all(results.map(async (r) => {
      try {
        const doiMatch = r.link.match(/doi\.org\/(10\.\d{4,}\/[^\s"'?#]+)/i) ||
                         r.snippet?.match(/\b(10\.\d{4,}\/[^\s"'<>\]]+)\b/);
        return doiMatch ? { ...r, doi: doiMatch[1], meta: { sourceType: 'journal' } } : r;
      } catch { return r; }
    }));
  },

  // ─── MODULE 5: LLM Relevance Filter (Final JSON Output) ───────────────────
  async _llmFilter(results, essay, groqKey) {
    const summaries = results
      .map((r, i) => `[${i}] Title: ${r.title}\n    Link: ${r.link}\n    Snippet: ${(r.snippet || '').substring(0, 180)}`)
      .join('\n\n');

    const prompt = `You are an academic research librarian. Filter these search results to find only the most relevant, credible sources for the essay below.

ESSAY / ARGUMENT:
"""
${essay.substring(0, 800)}
"""

SEARCH RESULTS:
${summaries}

TASK: Return a JSON object where:
- "kept_sources" is an array of INDICES (numbers) of the results to KEEP
- ONLY keep results that directly support, analyze, or provide credible evidence for claims in the essay
- REJECT: generic summaries, non-academic blogs, essay mills, or tangentially related content
- Return ONLY raw JSON, e.g. {"kept_sources": [0, 2, 5]}`;

    try {
      const res = await GroqAPI.chat([{ role: 'user', content: prompt }], groqKey, false);
      const match = res.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Invalid JSON format');
      const parsed = JSON.parse(match[0]);

      if (!Array.isArray(parsed.kept_sources) || parsed.kept_sources.length === 0) {
        throw new Error('LLM returned no kept sources');
      }

      // Map indices back to actual source objects
      const kept = parsed.kept_sources
        .filter(i => Number.isInteger(i) && i >= 0 && i < results.length)
        .map(i => results[i]);

      // Safety net: if LLM over-filters, return top 3 highest-quality raw results
      if (kept.length < 2) {
        console.warn('[Pipeline] LLM filtered too aggressively, returning top 3 fallback');
        return { kept_sources: results.slice(0, 3) };
      }

      return { kept_sources: kept };
    } catch (e) {
      console.warn('[Pipeline] LLM filter failed:', e.message);
      return { kept_sources: results.slice(0, 5) }; // Fail-open
    }
  }
};
