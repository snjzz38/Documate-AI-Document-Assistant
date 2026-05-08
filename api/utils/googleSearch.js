// api/utils/googleSearch.js — IMPROVED v4
// Fixes: Better fallbacks, robust error handling, timeout management, instance diversity

import { GroqAPI } from './groqAPI.js';

// ─── Configuration ────────────────────────────────────────────────────────────
const _CFG = {
  instances: [
    'https://priv.au',
    'https://search.sapti.me',
    'https://searx.tiekoetter.com',
    'https://search.bus-hit.me',
    'https://searx.be',
    'https://search.ononoki.org',
    'https://searxng.site',
    'https://paulgo.io',
  ],
  timeout: 8000,           // 8s per instance
  maxQueriesPerEssay: 3,
  maxResultsPerQuery: 8,
  maxTotalResults: 35,
  hardBlock: new Set([
    'reddit.com', 'quora.com', 'stackoverflow.com',
    'youtube.com', 'tiktok.com', 'instagram.com', 'facebook.com',
    'twitter.com', 'x.com', 'pinterest.com',
  ]),
};

// ─── Public API ───────────────────────────────────────────────────────────────
export const GoogleSearchAPI = {

  /**
   * Main entry point with error resilience
   * @param {string} query - Essay text or search query
   * @param {string} _apiKey - Unused (kept for API compat)
   * @param {string} _cx - Unused (kept for API compat)
   * @param {string} groqKey - Groq API key (optional)
   * @param {object} opts - { timeRange: 'day'|'month'|'year'|null }
   * @returns {Promise<Array>} Filtered, structured sources
   */
  async search(query, _apiKey, _cx, groqKey = null, opts = {}) {
    const { timeRange = null } = opts;

    // Input validation
    if (!query || typeof query !== 'string') {
      console.error('[Search] Invalid query input');
      return [];
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 3) {
      console.error('[Search] Query too short (< 3 chars)');
      return [];
    }

    try {
      // ── STEP 1: Generate search queries ─────────────────────────────────
      const queries = await this._generateQueries(trimmedQuery, groqKey);
      if (queries.length === 0) {
        console.warn('[Search] No queries generated, returning empty');
        return [];
      }
      console.log('[Search] Generated queries:', queries);

      // ── STEP 2: Fetch raw results from SearXNG instances ────────────────
      const raw = await this._fetchAllWithRetry(queries, { timeRange });
      if (raw.length === 0) {
        console.warn('[Search] No results from any instance');
        return [];
      }
      console.log(`[Search] Fetched ${raw.length} raw results`);

      // ── STEP 3: Structure results ──────────────────────────────────────
      const structured = this._structureResults(raw);
      console.log(`[Search] Structured ${structured.length} results`);

      // ── STEP 4: LLM-based relevance filtering (optional) ────────────────
      const filtered = groqKey
        ? await this._llmFilter(structured, trimmedQuery, groqKey).catch(e => {
            console.warn('[Search] LLM filter failed, using all structured:', e.message);
            return structured;
          })
        : structured;

      console.log(`[Search] Returning ${filtered.length} final sources`);
      return filtered;

    } catch (error) {
      console.error('[Search] Pipeline error:', error.message);
      // Fail-open: return what we have rather than crashing
      return [];
    }
  },

  // ─── MODULE: Query Generation (Robust) ──────────────────────────────────

  /**
   * Generate 2-3 targeted queries, with strong fallback if LLM fails
   */
  async _generateQueries(essay, groqKey) {
    if (!groqKey) {
      return this._generateQueriesFallback(essay);
    }

    try {
      const prompt = `You are an academic research assistant. Generate exactly 2-3 targeted search queries to find scholarly sources related to the text below.

TEXT (first 1000 chars):
"""
${essay.substring(0, 1000)}
"""

REQUIREMENTS:
- Each query must be 6-12 words, complete and academic-style
- Focus on key concepts, themes, claims in the text
- Avoid generic queries like "research" or "study"
- Return ONLY a raw JSON array: ["query 1", "query 2"]

DO NOT include markdown, code fences, or explanations.`;

      const response = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        groqKey,
        false
      );

      // Extract JSON array from response
      const match = response.match(/\[[\s\S]*?\]/);
      if (!match) {
        throw new Error('No JSON array found in response');
      }

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Parsed result is not a non-empty array');
      }

      // Validate and clean queries
      const queries = parsed
        .filter(q => typeof q === 'string' && q.trim().length >= 5)
        .map(q => q.trim().substring(0, 150))
        .slice(0, _CFG.maxQueriesPerEssay);

      if (queries.length === 0) {
        throw new Error('No valid queries after filtering');
      }

      return queries;

    } catch (error) {
      console.warn('[Search] LLM query generation failed:', error.message);
      return this._generateQueriesFallback(essay);
    }
  },

  /**
   * Fallback query generation (no LLM required)
   */
  _generateQueriesFallback(essay) {
    // Extract sentences and named entities
    const sentences = essay.match(/[^.!?]+[.!?]+/g) || [essay];
    const named = (essay.match(/\b[A-Z][a-z]{3,}(?:\s[A-Z][a-z]+)?\b/g) || [])
      .filter(w => !['The', 'This', 'That', 'In', 'By', 'It'].includes(w));

    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
      'have', 'has', 'do', 'does', 'did', 'will', 'would', 'should', 'could',
      'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
    ]);

    const words = (essay.toLowerCase().match(/\b[a-z]{5,}\b/g) || [])
      .filter(w => !stopWords.has(w))
      .slice(0, 8);

    const queries = [];

    // Query 1: Named entities + keyword
    if (named.length > 0 && words.length > 0) {
      queries.push(`${named.slice(0, 2).join(' ')} ${words.slice(0, 2).join(' ')} research`);
    }

    // Query 2: First 2-3 sentences
    if (sentences.length > 0) {
      const q = sentences[0].trim().substring(0, 100);
      if (q.length > 10) queries.push(q);
    }

    // Query 3: Keywords from middle of essay
    if (words.length > 3) {
      queries.push(words.slice(2, 5).join(' ') + ' academic study');
    }

    // Return at least 2 valid queries
    return queries
      .filter(q => q && q.length >= 5)
      .slice(0, _CFG.maxQueriesPerEssay)
      .map(q => q.trim().substring(0, 150));
  },

  // ─── MODULE: Fetch with Retry & Timeout ────────────────────────────────

  /**
   * Fetch from multiple SearXNG instances with retries and timeout
   */
  async _fetchAllWithRetry(queries, { timeRange }) {
    const allResults = [];
    const seenUrls = new Set();

    // Shuffle instances to distribute load
    const instances = [..._CFG.instances].sort(() => Math.random() - 0.5);

    for (const query of queries) {
      let bestBatch = [];

      // Try instances in order until one succeeds with 4+ results
      for (const instance of instances) {
        try {
          const batch = await this._fetchWithTimeout(instance, query, { timeRange });
          bestBatch = batch;
          if (batch.length >= 4) break; // Good instance, move to next query
        } catch (error) {
          console.warn(`[Search] ${instance} failed for "${query}": ${error.message}`);
          continue; // Try next instance
        }
      }

      // Dedupe and collect
      for (const result of bestBatch) {
        if (result.link && !seenUrls.has(result.link)) {
          try {
            const domain = new URL(result.link).hostname.replace('www.', '').toLowerCase();
            if (!_CFG.hardBlock.has(domain)) {
              allResults.push(result);
              seenUrls.add(result.link);
              if (allResults.length >= _CFG.maxTotalResults) break;
            }
          } catch (e) {
            console.warn('[Search] Invalid URL:', result.link);
          }
        }
      }

      if (allResults.length >= _CFG.maxTotalResults) break;
    }

    return allResults;
  },

  /**
   * Fetch with timeout and JSON/HTML fallback
   */
  async _fetchWithTimeout(instanceUrl, query, { timeRange }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), _CFG.timeout);

    try {
      // Try JSON first (faster, more structured)
      const jsonResults = await this._fetchJSON(
        instanceUrl,
        query,
        { timeRange },
        controller
      );

      clearTimeout(timeout);
      if (jsonResults.length > 0) {
        return jsonResults;
      }

      // Fallback to HTML scrape
      console.warn(`[Search] JSON empty from ${instanceUrl}, trying HTML`);
      return await this._fetchHTML(
        instanceUrl,
        query,
        { timeRange },
        controller
      );

    } catch (error) {
      clearTimeout(timeout);

      // If JSON failed, try HTML as fallback
      if (error.message.includes('JSON')) {
        try {
          return await this._fetchHTML(
            instanceUrl,
            query,
            { timeRange },
            controller
          );
        } catch (htmlError) {
          throw new Error(`Both JSON and HTML failed: ${htmlError.message}`);
        }
      }

      throw error;
    }
  },

  /**
   * Fetch from SearXNG JSON API (preferred)
   */
  async _fetchJSON(instanceUrl, query, { timeRange }, controller) {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      categories: 'general,science',
      language: 'en',
      engines: 'google,bing,duckduckgo,brave,semantic_scholar,crossref',
    });

    if (timeRange) {
      params.set('time_range', timeRange);
    }

    const url = `${instanceUrl}/search?${params.toString()}`;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: _CFG.timeout,
    });

    if (response.status === 403) {
      throw new Error('JSON_DISABLED');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('JSON_DISABLED');
    }

    let data;
    try {
      data = await response.json();
    } catch (e) {
      throw new Error('JSON_PARSE_ERROR');
    }

    if (!data.results || !Array.isArray(data.results)) {
      throw new Error('INVALID_RESPONSE_STRUCTURE');
    }

    return data.results
      .filter(r => r.url && r.title && r.title.length > 5)
      .slice(0, _CFG.maxResultsPerQuery)
      .map(r => ({
        title: r.title.trim(),
        link: r.url,
        snippet: (r.content || r.snippet || '').trim(),
        engine: r.engine || 'unknown',
      }));
  },

  /**
   * Fetch from SearXNG HTML (fallback)
   */
  async _fetchHTML(instanceUrl, query, { timeRange }, controller) {
    const params = new URLSearchParams({
      q: query,
      categories: 'general,science',
      language: 'en',
    });

    if (timeRange) {
      params.set('time_range', timeRange);
    }

    const url = `${instanceUrl}/search?${params.toString()}`;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: _CFG.timeout,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    return this._parseHTML(html);
  },

  /**
   * Parse SearXNG HTML response
   */
  _parseHTML(html) {
    const results = [];
    const seen = new Set();

    // Try multiple patterns for robustness
    const patterns = [
      /<article[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/article>/gi,
      /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const block = match[1];

        const urlMatch = block.match(/href="(https?:\/\/[^"#?]+)"/);
        const titleMatch = block.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/);
        const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);

        if (urlMatch && titleMatch) {
          const link = this._cleanUrl(urlMatch[1]);
          const title = this._cleanHtml(titleMatch[1]);

          if (title.length > 5 && !seen.has(link)) {
            results.push({
              title,
              link,
              snippet: snippetMatch ? this._cleanHtml(snippetMatch[1]) : '',
              engine: 'html',
            });
            seen.add(link);
          }
        }

        if (results.length >= _CFG.maxResultsPerQuery) {
          return results;
        }
      }
    }

    return results;
  },

  /**
   * Helper: Clean HTML entities and tags
   */
  _cleanHtml(html) {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 500);
  },

  /**
   * Helper: Clean URL (remove fragments, etc.)
   */
  _cleanUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  },

  // ─── MODULE: Structure Results ──────────────────────────────────────────

  /**
   * Convert raw results to citation-ready format
   */
  _structureResults(raw) {
    return raw.map((r, i) => ({
      id: i + 1,
      title: r.title || 'Untitled',
      link: r.link,
      snippet: r.snippet || '',
      content: r.snippet || '',
      doi: this._extractDOI(r.link, r.snippet),
      meta: {
        author: null,
        year: 'n.d.',
        published: 'n.d.',
        siteName: this._getSiteName(r.link),
        isDOI: false,
      },
      engine: r.engine || '',
    }));
  },

  /**
   * Extract DOI if present
   */
  _extractDOI(url, snippet = '') {
    const urlMatch = url.match(/doi\.org\/(10\.\d{4,}\/[^\s"'?#]+)/i);
    if (urlMatch) return urlMatch[1];

    const snippetMatch = snippet?.match(/\b(10\.\d{4,}\/[^\s"'<>\]]+)\b/);
    return snippetMatch ? snippetMatch[1] : null;
  },

  /**
   * Extract site name from URL
   */
  _getSiteName(url) {
    try {
      const host = new URL(url).hostname.replace('www.', '');
      const parts = host.split('.');
      const name = parts[0];
      return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    } catch {
      return 'Unknown';
    }
  },

  // ─── MODULE: LLM Relevance Filter (Optional, Fail-Safe) ──────────────────

  /**
   * Use LLM to filter to only relevant sources (optional improvement)
   */
  async _llmFilter(sources, essay, groqKey) {
    if (sources.length < 3) {
      return sources; // Skip filtering if too few
    }

    try {
      const sourceList = sources
        .slice(0, 20)
        .map(
          (s, i) =>
            `[${s.id}] "${s.title}"\n    ${s.snippet.substring(0, 160)}\n    Domain: ${new URL(s.link).hostname}`
        )
        .join('\n\n');

      const prompt = `Filter these search results to find only relevant, credible sources for the text below.

TEXT (first 800 chars):
"""
${essay.substring(0, 800)}
"""

SEARCH RESULTS:
${sourceList}

TASK: Return ONLY a JSON object with "kept_ids" (array of source IDs to keep):
- Keep 5-12 of the most relevant sources
- Reject generic content, blogs, or off-topic results
- Prefer academic, authoritative sources
- Return: {"kept_ids": [1, 3, 5]}`;

      const response = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        groqKey,
        false
      );

      const match = response.match(/\{[\s\S]*?\}/);
      if (!match) {
        throw new Error('No JSON in response');
      }

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.kept_ids) || parsed.kept_ids.length === 0) {
        throw new Error('Empty kept_ids');
      }

      const kept = sources.filter(s => parsed.kept_ids.includes(s.id));
      return kept.length > 0 ? kept : sources.slice(0, 10);

    } catch (error) {
      console.warn('[Search] LLM filter failed, returning all:', error.message);
      return sources;
    }
  },
};
