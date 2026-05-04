// api/utils/scraper.js
// Academic Metadata Scraper — Simplified v2
// Focus: DOI resolution + essential citation fields. Fallback to SearXNG data.

import { DoiAPI } from './doiAPI.js';

const CONFIG = {
  timeout: 5000,
  maxSources: 15,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  // Cache to avoid re-fetching same URL in one session
  cache: new Map(),
};

export const ScraperAPI = {
  /**
   * Enrich search results with citation metadata.
   * @param {Array} sources - Results from GoogleSearchAPI
   * @returns {Array} Same results + meta: {author, year, doi, siteName}
   */
  async scrape(sources) {
    if (!Array.isArray(sources) || sources.length === 0) return [];

    const results = await Promise.all(
      sources.slice(0, CONFIG.maxSources).map((source, idx) => 
        this._enrich(source, idx).catch(err => {
          console.warn('[Scraper] Failed:', source.link, err.message);
          return this._fallback(source, idx);
        })
      )
    );
    return results;
  },

  async _enrich(source, index) {
    // Return cached result if available
    if (CONFIG.cache.has(source.link)) {
      return { ...CONFIG.cache.get(source.link), id: index + 1 };
    }

    // Skip PDFs and known non-HTML
    if (this._isBinary(source.link)) {
      return this._fallback(source, index);
    }

    // STRATEGY 1: DOI-first (highest value)
    const doi = this._extractDOI(source.link, source.snippet);
    if (doi) {
      const doiData = await DoiAPI.fetchFromCrossref(doi);
      if (doiData) {
        const result = {
          ...source,
          id: index + 1,
          title: doiData.title || source.title,
          content: doiData.abstract || source.snippet || '',
          doi: doiData.doi,
          meta: {
            author: this._formatAuthors(doiData.authors),
            authors: doiData.authors,
            year: doiData.year || 'n.d.',
            published: doiData.year,
            siteName: doiData.journal || this._getSiteName(source.link),
            isDOI: true,
          },
        };
        CONFIG.cache.set(source.link, result);
        return result;
      }
    }

    // STRATEGY 2: Lightweight HTML fetch for meta tags only
    try {
      const meta = await this._fetchMeta(source.link);
      const result = {
        ...source,
        id: index + 1,
        // Keep SearXNG snippet — it's often better than scraped preview
        content: source.snippet || '',
        meta: {
          author: meta.author || null,
          year: meta.year || 'n.d.',
          published: meta.year,
          siteName: meta.siteName || this._getSiteName(source.link),
          isDOI: false,
        },
      };
      CONFIG.cache.set(source.link, result);
      return result;
    } catch {
      return this._fallback(source, index);
    }
  },

  // ─── DOI Handling ─────────────────────────────────────────────────────────
  
  _extractDOI(url, snippet = '') {
    // Check doi.org URLs first
    const doiOrgMatch = url.match(/doi\.org\/(10\.\d{4,}\/[^\s"'?#]+)/i);
    if (doiOrgMatch) return doiOrgMatch[1];
    
    // Check snippet for DOI patterns
    const snippetMatch = snippet?.match(/\b(10\.\d{4,}\/[^\s"'<>\]]+)\b/);
    if (snippetMatch) return snippetMatch[1];
    
    return null;
  },

  // ─── Lightweight Meta Fetch ───────────────────────────────────────────────
  
  async _fetchMeta(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
    
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': CONFIG.userAgent, 'Accept': 'text/html' },
      });
      clearTimeout(timer);
      
      if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) {
        return {};
      }
      
      const html = await res.text();
      return this._parseMeta(html, url);
    } catch {
      clearTimeout(timer);
      return {};
    }
  },

  _parseMeta(html, url) {
    const meta = {};
    
    // JSON-LD (most reliable)
    try {
      const jsonLd = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
      if (jsonLd) {
        const data = JSON.parse(jsonLd);
        const item = data['@graph']?.[0] || data;
        if (item.author) {
          meta.author = Array.isArray(item.author) 
            ? item.author[0]?.name || item.author[0] 
            : item.author.name || item.author;
        }
        if (item.datePublished) {
          meta.year = item.datePublished.match(/\b(20\d{2})\b/)?.[1];
        }
        if (item.publisher?.name) {
          meta.siteName = item.publisher.name;
        }
      }
    } catch {}
    
    // Fallback: meta tags
    if (!meta.author) {
      meta.author = html.match(/<meta[^>]*name=["'](?:author|citation_author)["'][^>]*content=["']([^"']+)["']/i)?.[1];
    }
    if (!meta.year) {
      meta.year = html.match(/<meta[^>]*(?:published_time|citation_date|DC\.date)["'][^>]*content=["'][^"]*(20\d{2})/i)?.[1];
    }
    if (!meta.siteName) {
      meta.siteName = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)?.[1];
    }
    
    // Clean author
    if (meta.author) {
      meta.author = meta.author.replace(/^(By|Author:)\s*/i, '').trim();
      if (meta.author.length < 3 || meta.author.length > 60 || /^https?:\/\//i.test(meta.author)) {
        delete meta.author;
      }
    }
    
    return meta;
  },

  // ─── Utilities ────────────────────────────────────────────────────────────
  
  _formatAuthors(authors) {
    if (!authors?.length) return null;
    if (authors.length === 1) return authors[0].family || authors[0].given;
    if (authors.length === 2) return `${authors[0].family} and ${authors[1].family}`;
    return `${authors[0].family} et al.`;
  },

  _getSiteName(url) {
    try {
      const host = new URL(url).hostname.replace('www.', '');
      return host.split('.')[0].replace(/^([a-z])/, c => c.toUpperCase());
    } catch {
      return 'Unknown';
    }
  },

  _isBinary(url) {
    const lower = url.toLowerCase();
    return lower.endsWith('.pdf') || 
           lower.includes('/pdf/') || 
           lower.includes('pdfs.semanticscholar.org') ||
           /\.(zip|exe|dmg|docx?|xlsx?)$/i.test(lower);
  },

  _fallback(source, index) {
    const result = {
      ...source,
      id: index + 1,
      content: source.snippet || '',
      meta: {
        author: null,
        year: 'n.d.',
        published: 'n.d.',
        siteName: this._getSiteName(source.link),
        isDOI: false,
      },
    };
    CONFIG.cache.set(source.link, result);
    return result;
  },

  // Optional: clear cache between searches
  clearCache() {
    CONFIG.cache.clear();
  },
};
