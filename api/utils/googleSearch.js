// api/utils/googleSearch.js — SIMPLIFIED v5
// Focus: Relevant queries only, aggressive filtering of junk results

import { GroqAPI } from './groqAPI.js';

// ─── Configuration ────────────────────────────────────────────────────────────
const _CFG = {
  instances: [
    'https://priv.au',
    'https://search.sapti.me',
    'https://searx.tiekoetter.com',
    'https://search.bus-hit.me',
    'https://searx.be',
  ],
  timeout: 6000,
  maxQueriesGenerated: 4,
  maxResultsPerQuery: 6,
  maxTotalResults: 20,
  // Hard block: Social media, forums, streaming, forums, email, help docs
  hardBlock: new Set([
    'reddit.com', 'quora.com', 'stackoverflow.com', 'stackexchange.com',
    'youtube.com', 'tiktok.com', 'instagram.com', 'facebook.com',
    'twitter.com', 'x.com', 'pinterest.com', 'twitch.tv',
    'amazon.com', 'ebay.com', 'etsy.com', 'alibaba.com',
    'netflix.com', 'hulu.com', 'disneyplus.com', 'primevideo.com',
    'answers.microsoft.com', 'support.google.com', 'apple.com/support',
    'outlook.com', 'gmail.com', 'mail.google.com',
    'github.com', 'gitlab.com', 'bitbucket.org', // Code hosting
  ]),
  // Junk/low-value domains
  junkDomains: new Set([
    'dokumen.pub', 'scribd.com', 'academia.edu', // PDF/doc mills
    'wattpad.com', 'fanfiction.net', // Fan content
    'grokipedia.com', 'wikipedia.com', // Non-authoritative
    'chegg.com', 'brainly.com', 'coursehero.com', // Homework mills
  ]),
};

// ─── Public API ───────────────────────────────────────────────────────────────
export const GoogleSearchAPI = {

  /**
   * Main search entry point
   * @param {string} essay - Essay text or query
   * @param {string} _apiKey - Unused
   * @param {string} _cx - Unused
   * @param {string} groqKey - Groq API key (required for smart queries)
   * @param {object} opts - { timeRange: 'day'|'month'|'year'|null }
   * @returns {Promise<Array>} Filtered sources
   */
  async search(essay, _apiKey, _cx, groqKey = null, opts = {}) {
    const { timeRange = null } = opts;

    // Input validation
    if (!essay || typeof essay !== 'string' || essay.trim().length < 10) {
      console.error('[Search] Invalid essay: must be string, 10+ chars');
      return [];
    }

    const essayText = essay.trim();

    try {
      // ── STEP 1: Generate 3-4 highly relevant queries ─────────────────
      const queries = groqKey
        ? await this._generateSmartQueries(essayText, groqKey)
        : this._generateFallbackQueries(essayText);

      if (queries.length === 0) {
        console.warn('[Search] No queries generated');
        return [];
      }

      console.log('[Search] Generated queries:', queries);

      // ── STEP 2: Fetch + filter aggressively ─────────────────────────
      const raw = await this._fetchAllQueries(queries, { timeRange });
      if (raw.length === 0) {
        console.warn('[Search] No results from any query');
        return [];
      }

      console.log(`[Search] Raw results: ${raw.length}`);

      // ── STEP 3: Hard filter (remove junk) ───────────────────────────
      const hardFiltered = this._hardFilter(raw);
      console.log(`[Search] After hard filter: ${hardFiltered.length}`);

      // ── STEP 4: Smart relevance filter with LLM ─────────────────────
      const final = groqKey
        ? await this._relevanceFilter(hardFiltered, essayText, groqKey).catch(e => {
            console.warn('[Search] Relevance filter failed, using hard-filtered:', e.message);
            return hardFiltered;
          })
        : hardFiltered;

      console.log(`[Search] Final results: ${final.length}`);
      return this._structureForCitation(final);

    } catch (error) {
      console.error('[Search] Pipeline error:', error.message);
      return [];
    }
  },

  // ─── STEP 1: Query Generation ──────────────────────────────────────

  /**
   * Generate 3-4 focused, on-topic queries using LLM
   */
  async _generateSmartQueries(essay, groqKey) {
    const prompt = `You are generating academic search queries for a scholarly essay.

ESSAY TEXT (first 1200 chars):
"""
${essay.substring(0, 1200)}
"""

TASK: Generate 3-4 focused, scholarly search queries that will find RELEVANT academic sources.

REQUIREMENTS:
1. Each query must be 8-15 words (specific and detailed)
2. Focus on MAIN CLAIMS, KEY CONCEPTS, and CENTRAL ARGUMENTS in the essay
3. Each query must be about a DIFFERENT aspect or claim
4. Avoid generic queries like "research" or "study"
5. Queries should target academic databases, journals, books
6. NO queries about unrelated topics or tangents

EXAMPLES OF GOOD QUERIES:
- "Modernism in Russian poetry early 20th century literary analysis"
- "emotional expression aesthetic philosophy contemporary visual art"
- "climate change impact marine ecosystems biodiversity conservation"

EXAMPLES OF BAD QUERIES:
- "research study" (too generic)
- "Netflix streaming services" (if not in essay)
- "help support guides" (off-topic)

Return ONLY a JSON array of strings (no markdown, no explanations):
["query 1", "query 2", "query 3"]`;

    try {
      const response = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        groqKey,
        false
      );

      const match = response.match(/\[[\s\S]*?\]/);
      if (!match) throw new Error('No JSON array in response');

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Empty query array');
      }

      // Validate: must be strings, 8+ words, reasonable length
      const queries = parsed
        .filter(q => {
          if (typeof q !== 'string') return false;
          const clean = q.trim();
          const wordCount = clean.split(/\s+/).length;
          return wordCount >= 6 && clean.length >= 20 && clean.length <= 200;
        })
        .map(q => q.trim())
        .slice(0, _CFG.maxQueriesGenerated);

      if (queries.length === 0) {
        throw new Error('No valid queries after filtering');
      }

      return queries;

    } catch (error) {
      console.warn('[Search] Smart query generation failed:', error.message);
      return this._generateFallbackQueries(essay);
    }
  },

  /**
   * Fallback: Generate queries from essay text directly
   */
  _generateFallbackQueries(essay) {
    const queries = [];

    // Extract main topic keywords
    const sentences = essay.match(/[^.!?]+[.!?]/g) || [essay];
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
      'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
      'might', 'must', 'can', 'this', 'that', 'these', 'those', 'it', 'its',
    ]);

    // Extract meaningful words (5+ chars, not stop words)
    const words = (essay.toLowerCase().match(/\b[a-z]{5,}\b/g) || [])
      .filter(w => !stopWords.has(w))
      .filter((v, i, a) => a.indexOf(v) === i); // Dedup

    // Extract named entities (capitalized words)
    const named = (essay.match(/\b[A-Z][a-z]{3,}(?:\s[A-Z][a-z]+)?\b/g) || [])
      .filter((v, i, a) => a.indexOf(v) === i); // Dedup

    // Query 1: First meaningful sentence
    if (sentences.length > 0) {
      const q = sentences[0]
        .replace(/[.!?]/g, '')
        .trim()
        .substring(0, 120);
      if (q.length >= 20) queries.push(q);
    }

    // Query 2: Named entities + keywords
    if (named.length >= 2 && words.length >= 2) {
      queries.push(
        `${named.slice(0, 2).join(' ')} ${words.slice(0, 2).join(' ')} research`
      );
    }

    // Query 3: Keywords from middle of essay
    if (words.length >= 3) {
      queries.push(words.slice(1, 4).join(' '));
    }

    // Query 4: Named entity alone (if strong)
    if (named.length >= 1 && named[0].length >= 4) {
      queries.push(`${named[0]} analysis literature`);
    }

    return queries
      .filter(q => q && q.length >= 15)
      .slice(0, _CFG.maxQueriesGenerated)
      .map(q => q.trim().substring(0, 150));
  },

  // ─── STEP 2: Fetch All Queries ────────────────────────────────────

  /**
   * Fetch from multiple SearXNG instances for each query
   */
  async _fetchAllQueries(queries, { timeRange }) {
    const allResults = [];
    const seenUrls = new Set();

    for (const query of queries) {
      try {
        const results = await this._fetchOneQuery(query, { timeRange });
        
        for (const r of results) {
          if (r.link && !seenUrls.has(r.link)) {
            allResults.push(r);
            seenUrls.add(r.link);
            if (allResults.length >= _CFG.maxTotalResults) break;
          }
        }
      } catch (error) {
        console.warn(`[Search] Query failed: "${query}" — ${error.message}`);
      }

      if (allResults.length >= _CFG.maxTotalResults) break;
    }

    return allResults;
  },

  /**
   * Fetch one query from best available instance
   */
  async _fetchOneQuery(query, { timeRange }) {
    const instances = [..._CFG.instances].sort(() => Math.random() - 0.5);

    for (const instance of instances) {
      try {
        const results = await this._fetchFromInstance(instance, query, { timeRange });
        if (results.length > 0) {
          console.log(`[Search] ✓ ${results.length} from ${instance}`);
          return results;
        }
      } catch (error) {
        console.warn(`[Search] ✗ ${instance}: ${error.message}`);
      }
    }

    throw new Error('All instances failed');
  },

  /**
   * Fetch from single SearXNG instance with timeout
   */
  async _fetchFromInstance(instanceUrl, query, { timeRange }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), _CFG.timeout);

    try {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        categories: 'general,science',
        language: 'en',
        engines: 'google,bing,duckduckgo,brave,semantic_scholar,crossref',
        ...(timeRange && { time_range: timeRange }),
      });

      const response = await fetch(`${instanceUrl}/search?${params}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        throw new Error('Not JSON');
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('JSON parse error');
      }

      if (!data.results || !Array.isArray(data.results)) {
        throw new Error('No results array');
      }

      return data.results
        .filter(r => r.url && r.title && r.title.length > 5)
        .slice(0, _CFG.maxResultsPerQuery)
        .map(r => ({
          title: r.title.trim(),
          link: r.url,
          snippet: (r.content || r.snippet || '').trim(),
        }));

    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
  },

  // ─── STEP 3: Hard Filter (Remove Junk) ─────────────────────────────

  /**
   * Remove blocked/junk domains before relevance check
   */
  _hardFilter(results) {
    return results.filter(r => {
      if (!r.link || !r.title) return false;

      try {
        const url = new URL(r.link);
        const domain = url.hostname.replace('www.', '').toLowerCase();

        // Hard block: social, forums, streaming, support
        if (_CFG.hardBlock.has(domain)) {
          console.log(`[Filter] Hard blocked: ${domain}`);
          return false;
        }

        // Junk domains: low-value sources
        if (_CFG.junkDomains.has(domain)) {
          console.log(`[Filter] Junk domain: ${domain}`);
          return false;
        }

        // Image/media extensions
        const path = url.pathname.toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.mp3'].some(ext => path.endsWith(ext))) {
          return false;
        }

        // Title quality checks
        if (r.title.length < 5 || r.title.length > 300) {
          return false;
        }

        // Generic/help/support red flags
        const titleLower = r.title.toLowerCase();
        const snippetLower = (r.snippet || '').toLowerCase();
        const urlLower = r.link.toLowerCase();

        const junkPatterns = [
          /^(how to|tutorial|guide:|step by step)/i,
          /netflix|streaming|watch/i,
          /error|troubleshoot|can't|not working/i,
          /login|signup|account|password/i,
          /download\s+(pdf|ebook|movie|video)/i,
          /illegal|pirate|torrent/i,
        ];

        if (junkPatterns.some(p => p.test(titleLower) && p.test(snippetLower))) {
          console.log(`[Filter] Junk pattern in title: ${r.title.substring(0, 50)}`);
          return false;
        }

        return true;
      } catch (e) {
        console.warn(`[Filter] Invalid URL: ${r.link}`);
        return false;
      }
    });
  },

  // ─── STEP 4: Relevance Filter (LLM) ───────────────────────────────

  /**
   * Use LLM to verify each source is actually relevant to the essay
   */
  async _relevanceFilter(sources, essay, groqKey) {
    if (sources.length < 3) {
      return sources; // Too few to filter
    }

    const sourceList = sources
      .slice(0, 25)
      .map(
        (s, i) =>
          `[${i + 1}] "${s.title}"\n    ${s.snippet.substring(0, 140)}\n    Domain: ${this._getDomain(s.link)}`
      )
      .join('\n\n');

    const prompt = `You are a research librarian. Evaluate these sources for RELEVANCE to the essay topic.

ESSAY (first 900 chars):
"""
${essay.substring(0, 900)}
"""

SOURCES TO EVALUATE:
${sourceList}

TASK: Return ONLY a JSON object with:
- "relevant_ids": array of source IDs that are DIRECTLY relevant to the essay topic
- Keep 5-15 sources
- REJECT: off-topic sources, help docs, streaming services, social media, forums
- ACCEPT: academic papers, books, reputable articles on the topic
- If unsure, be STRICT — better to reject doubtful sources

Format: {"relevant_ids": [1, 3, 5, 7]}`;

    try {
      const response = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        groqKey,
        false
      );

      const match = response.match(/\{[\s\S]*?\}/);
      if (!match) throw new Error('No JSON in response');

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.relevant_ids) || parsed.relevant_ids.length === 0) {
        throw new Error('No relevant sources found by LLM');
      }

      const relevant = sources.filter((_, i) => parsed.relevant_ids.includes(i + 1));
      return relevant.length > 0 ? relevant : sources.slice(0, 10);

    } catch (error) {
      console.warn('[Search] LLM relevance filter failed:', error.message);
      // Return all sources if LLM fails
      return sources;
    }
  },

  // ─── STEP 5: Structure for Citation ───────────────────────────────

  /**
   * Convert to citation.js format
   */
  _structureForCitation(sources) {
    return sources.map((s, i) => ({
      id: i + 1,
      title: s.title || 'Untitled',
      link: s.link,
      snippet: s.snippet || '',
      content: s.snippet || '',
      doi: this._extractDOI(s.link, s.snippet),
      meta: {
        author: null,
        year: 'n.d.',
        published: 'n.d.',
        siteName: this._getSiteName(s.link),
        isDOI: false,
      },
      engine: 'search',
    }));
  },

  // ─── Helpers ──────────────────────────────────────────────────────

  _getDomain(url) {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return 'unknown';
    }
  },

  _getSiteName(url) {
    try {
      const host = new URL(url).hostname.replace('www.', '');
      const part = host.split('.')[0];
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    } catch {
      return 'Unknown';
    }
  },

  _extractDOI(url, snippet = '') {
    const urlMatch = url.match(/doi\.org\/(10\.\d{4,}\/[^\s"'?#]+)/i);
    if (urlMatch) return urlMatch[1];

    const snippetMatch = snippet?.match(/\b(10\.\d{4,}\/[^\s"'<>\]]+)\b/);
    return snippetMatch ? snippetMatch[1] : null;
  },
};
