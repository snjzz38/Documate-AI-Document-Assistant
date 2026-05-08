// api/utils/googleSearch.js — v6 FIXED
// Now uses current healthy instances from searx.space status report
// Includes rate-limit (429) backoff and better error recovery

import { GroqAPI } from './groqAPI.js';

// ─── Configuration ────────────────────────────────────────────────────────────
const _CFG = {
  // UPDATED: Healthy instances from searx.space status report (May 2026)
  // Prioritized by uptime % and response time
  instances: [
    'https://search.ononoki.org',           // 94%, 0.942s (DE/GB)
    'https://searx.tiekoetter.com',         // 100%, 0.697s (DE)
    'https://search.einfachzocken.eu',      // 100%, 0.831s (GB/DE)
    'https://priv.au',                      // 100%, 0.513s (DE/US)
    'https://searx.oloke.xyz',              // 100%, 0.551s (PL)
    'https://searx.party',                  // 100%, 0.552s (US)
    'https://searxng.canine.tools',         // 99%, 0.579s (US)
    'https://searxng.website',              // 100%, 0.722s (DE)
    'https://baresearch.org',               // 100%, 0.936s (US)
    'https://search.2b9t.xyz',              // 100%, 0.963s (US)
    'https://grep.vim.wtf',                 // 100%, 1.007s (DE)
    'https://search.chocolate...53.com',    // 100%, 1.374s (US)
    'https://search.url4irl.com',           // 100%, 0.747s (DE)
    'https://search.pereira.is',            // 89%, 0.108s (FR)
    'https://search.rowie.at',              // 100%, 0.307s (AT)
    'https://search.seddens.net',           // 100%, 0.044s (DE)
    'https://search.serpensin.com',         // 100%, 0.090s (DE)
    'https://search.zina.dev',              // 100%, 0.058s (DE)
    'https://searx.ankha.ac',               // 89%, 0.639s (US)
    'https://searx.tuxcloud.net',           // 100%, 0.111s (CZ)
    'https://seek.fyi',                     // 100%, 0.360s (US)
    'https://search.unredacted.org',        // 99%, 0.417s (US)
    'https://search.sapti.me',              // 99%, 0.133s (DE)
    'https://copp.gg',                      // 99%, 0.421s (US)
    'https://paulgo.io',                    // 100%, 0.046s (DE)
    'https://search.im-in.space',           // 100%, 0.059s (DE)
  ],
  timeout: 5000,                            // 5s per instance
  maxQueriesGenerated: 4,
  maxResultsPerQuery: 5,
  maxTotalResults: 20,
  
  // Instance rate limit tracking
  rateLimitTracker: new Map(),              // url -> { retryAfter: timestamp }
  
  hardBlock: new Set([
    'reddit.com', 'quora.com', 'stackoverflow.com', 'stackexchange.com',
    'youtube.com', 'tiktok.com', 'instagram.com', 'facebook.com',
    'twitter.com', 'x.com', 'pinterest.com', 'twitch.tv',
    'amazon.com', 'ebay.com', 'etsy.com', 'alibaba.com',
    'netflix.com', 'hulu.com', 'disneyplus.com', 'primevideo.com',
    'answers.microsoft.com', 'support.google.com', 'apple.com/support',
    'outlook.com', 'gmail.com', 'mail.google.com',
    'github.com', 'gitlab.com', 'bitbucket.org',
  ]),
  
  junkDomains: new Set([
    'dokumen.pub', 'scribd.com', 'academia.edu',
    'wattpad.com', 'fanfiction.net',
    'grokipedia.com',
    'chegg.com', 'brainly.com', 'coursehero.com',
  ]),
};

// ─── Public API ───────────────────────────────────────────────────────────────
export const GoogleSearchAPI = {

  /**
   * Main search entry point
   */
  async search(essay, _apiKey, _cx, groqKey = null, opts = {}) {
    const { timeRange = null } = opts;

    if (!essay || typeof essay !== 'string' || essay.trim().length < 10) {
      console.error('[Search] Invalid essay');
      return [];
    }

    const essayText = essay.trim();

    try {
      // ── STEP 1: Generate queries ────────────────────────────────────
      const queries = groqKey
        ? await this._generateSmartQueries(essayText, groqKey)
        : this._generateFallbackQueries(essayText);

      if (queries.length === 0) {
        console.warn('[Search] No queries generated');
        return [];
      }

      console.log('[Search] Generated queries:', queries);

      // ── STEP 2: Fetch with retry logic ─────────────────────────────
      const raw = await this._fetchAllQueriesWithRetry(queries, { timeRange });
      if (raw.length === 0) {
        console.warn('[Search] No results from any query');
        return [];
      }

      console.log(`[Search] Raw results: ${raw.length}`);

      // ── STEP 3: Hard filter ────────────────────────────────────────
      const hardFiltered = this._hardFilter(raw);
      console.log(`[Search] After hard filter: ${hardFiltered.length}`);

      // ── STEP 4: LLM relevance filter ───────────────────────────────
      const final = groqKey
        ? await this._relevanceFilter(hardFiltered, essayText, groqKey).catch(e => {
            console.warn('[Search] Relevance filter failed, using hard-filtered');
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

  async _generateSmartQueries(essay, groqKey) {
    const prompt = `You are generating academic search queries for a scholarly essay.

ESSAY TEXT (first 1200 chars):
"""
${essay.substring(0, 1200)}
"""

TASK: Generate 3-4 focused, scholarly search queries.

REQUIREMENTS:
1. Each query: 8-15 words, specific and detailed
2. Focus on MAIN CLAIMS and DIFFERENT ASPECTS
3. Avoid generic queries
4. Target academic databases, journals, books

Return ONLY a JSON array (no markdown):
["query 1", "query 2", "query 3"]`;

    try {
      const response = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        groqKey,
        false
      );

      const match = response.match(/\[[\s\S]*?\]/);
      if (!match) throw new Error('No JSON array');

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Empty array');
      }

      const queries = parsed
        .filter(q => {
          if (typeof q !== 'string') return false;
          const clean = q.trim();
          const wordCount = clean.split(/\s+/).length;
          return wordCount >= 6 && clean.length >= 20 && clean.length <= 200;
        })
        .map(q => q.trim())
        .slice(0, _CFG.maxQueriesGenerated);

      return queries.length > 0 ? queries : this._generateFallbackQueries(essay);

    } catch (error) {
      console.warn('[Search] Smart query gen failed:', error.message);
      return this._generateFallbackQueries(essay);
    }
  },

  _generateFallbackQueries(essay) {
    const queries = [];
    const sentences = essay.match(/[^.!?]+[.!?]/g) || [essay];
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
    ]);

    const words = (essay.toLowerCase().match(/\b[a-z]{5,}\b/g) || [])
      .filter(w => !stopWords.has(w))
      .filter((v, i, a) => a.indexOf(v) === i);

    const named = (essay.match(/\b[A-Z][a-z]{3,}(?:\s[A-Z][a-z]+)?\b/g) || [])
      .filter((v, i, a) => a.indexOf(v) === i);

    if (sentences.length > 0) {
      const q = sentences[0].replace(/[.!?]/g, '').trim().substring(0, 120);
      if (q.length >= 20) queries.push(q);
    }

    if (named.length >= 2 && words.length >= 2) {
      queries.push(`${named.slice(0, 2).join(' ')} ${words.slice(0, 2).join(' ')}`);
    }

    if (words.length >= 3) {
      queries.push(words.slice(1, 4).join(' '));
    }

    return queries
      .filter(q => q && q.length >= 15)
      .slice(0, _CFG.maxQueriesGenerated)
      .map(q => q.trim().substring(0, 150));
  },

  // ─── STEP 2: Fetch with Intelligent Retry ─────────────────────────

  /**
   * Fetch all queries with exponential backoff for rate limits
   */
  async _fetchAllQueriesWithRetry(queries, { timeRange }) {
    const allResults = [];
    const seenUrls = new Set();

    for (const query of queries) {
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts && allResults.length < _CFG.maxTotalResults) {
        try {
          const results = await this._fetchOneQuery(query, { timeRange });
          
          for (const r of results) {
            if (r.link && !seenUrls.has(r.link)) {
              allResults.push(r);
              seenUrls.add(r.link);
            }
          }

          if (results.length > 0) break; // Success, move to next query
          attempts++;

        } catch (error) {
          attempts++;
          if (attempts >= maxAttempts) {
            console.warn(`[Search] Query failed after ${maxAttempts} attempts: "${query}"`);
          } else {
            // Exponential backoff
            const backoffMs = Math.pow(2, attempts - 1) * 500;
            console.log(`[Search] Retry ${attempts}/${maxAttempts} for "${query}" after ${backoffMs}ms`);
            await new Promise(r => setTimeout(r, backoffMs));
          }
        }
      }

      if (allResults.length >= _CFG.maxTotalResults) break;
    }

    return allResults;
  },

  /**
   * Fetch one query from best available instance
   */
  async _fetchOneQuery(query, { timeRange }) {
    // Shuffle instances but prioritize non-rate-limited ones
    const now = Date.now();
    const active = [..._CFG.instances].filter(url => {
      const rateLimit = _CFG.rateLimitTracker.get(url);
      return !rateLimit || rateLimit < now;
    });

    const toTry = active.length > 0 ? active : _CFG.instances;
    const shuffled = [...toTry].sort(() => Math.random() - 0.5);

    for (const instance of shuffled.slice(0, 8)) { // Try top 8
      try {
        const results = await this._fetchFromInstance(instance, query, { timeRange });
        if (results.length > 0) {
          console.log(`[Search] ✓ ${results.length} from ${instance}`);
          return results;
        }
      } catch (error) {
        // Log specific error type
        if (error.message.includes('429')) {
          console.warn(`[Search] 🛑 ${instance}: Rate limited (429)`);
          // Back off for 30 seconds
          _CFG.rateLimitTracker.set(instance, now + 30000);
        } else {
          console.warn(`[Search] ✗ ${instance}: ${error.message}`);
        }
      }
    }

    throw new Error('All instances failed');
  },

  /**
   * Fetch from single instance with timeout
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

      // Handle rate limit
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const waitSeconds = retryAfter ? parseInt(retryAfter) : 30;
        const waitMs = waitSeconds * 1000;
        _CFG.rateLimitTracker.set(instanceUrl, Date.now() + waitMs);
        throw new Error(`429: Rate limited (retry after ${waitSeconds}s)`);
      }

      if (response.status === 403) {
        throw new Error('HTTP 403: Access denied');
      }

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

  // ─── STEP 3: Hard Filter ──────────────────────────────────────────

  _hardFilter(results) {
    return results.filter(r => {
      if (!r.link || !r.title) return false;

      try {
        const url = new URL(r.link);
        const domain = url.hostname.replace('www.', '').toLowerCase();

        if (_CFG.hardBlock.has(domain)) return false;
        if (_CFG.junkDomains.has(domain)) return false;

        const path = url.pathname.toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.mp3'].some(ext => path.endsWith(ext))) {
          return false;
        }

        if (r.title.length < 5 || r.title.length > 300) return false;

        const titleLower = r.title.toLowerCase();
        const snippetLower = (r.snippet || '').toLowerCase();

        const junkPatterns = [
          /^(how to|tutorial|guide:|step by step)/i,
          /netflix|streaming|watch/i,
          /error|troubleshoot|can't|not working/i,
          /login|signup|account|password/i,
          /download\s+(pdf|ebook|movie|video)/i,
          /illegal|pirate|torrent/i,
        ];

        if (junkPatterns.some(p => p.test(titleLower) && p.test(snippetLower))) {
          return false;
        }

        return true;
      } catch (e) {
        return false;
      }
    });
  },

  // ─── STEP 4: Relevance Filter (LLM) ───────────────────────────────

  async _relevanceFilter(sources, essay, groqKey) {
    if (sources.length < 3) return sources;

    const sourceList = sources
      .slice(0, 25)
      .map(
        (s, i) =>
          `[${i + 1}] "${s.title}"\n    ${s.snippet.substring(0, 140)}\n    Domain: ${this._getDomain(s.link)}`
      )
      .join('\n\n');

    const prompt = `Filter sources for RELEVANCE to this essay topic.

ESSAY (first 900 chars):
"""
${essay.substring(0, 900)}
"""

SOURCES:
${sourceList}

Return ONLY JSON: {"relevant_ids": [1, 3, 5]}
Keep 5-15 sources. Reject off-topic, help docs, forums.`;

    try {
      const response = await GroqAPI.chat(
        [{ role: 'user', content: prompt }],
        groqKey,
        false
      );

      const match = response.match(/\{[\s\S]*?\}/);
      if (!match) throw new Error('No JSON');

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.relevant_ids) || parsed.relevant_ids.length === 0) {
        throw new Error('No relevant IDs');
      }

      const relevant = sources.filter((_, i) => parsed.relevant_ids.includes(i + 1));
      return relevant.length > 0 ? relevant : sources.slice(0, 10);

    } catch (error) {
      console.warn('[Search] LLM filter failed:', error.message);
      return sources;
    }
  },

  // ─── STEP 5: Structure ────────────────────────────────────────────

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
