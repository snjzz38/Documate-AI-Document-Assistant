// api/utils/scraper.js - IMPROVED
// Better error handling, avoids 403-prone sites, focuses on academic sources

import { DoiAPI } from './doiAPI.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Domains that are known to block scraping or return 403
const BLOCKED_DOMAINS = new Set([
  'rae.es',
  'thefreedictionary.com',
  'dictionary.com',
  'britannica.com',
  'linkedin.com',
  'facebook.com',
  'twitter.com',
  'instagram.com',
  'youtube.com',
  'pinterest.com',
  'reddit.com',
  'patreon.com',
  'medium.com',
  'substack.com',
  'wordpress.com',
]);

// Domains that are primarily dictionary/reference (usually not citable for academic work)
const REFERENCE_ONLY_DOMAINS = new Set([
  'diccionarios.com',
  'wordreference.com',
  'merriam-webster.com',
  'oxforddictionaries.com',
  'cambridge.org/dictionary',
]);

export const ScraperAPI = {
  async scrape(sources) {
    const results = await Promise.all(
      sources.slice(0, 20).map(async (source, index) => {
        try {
          // Check if domain is blocked/dictionary-only
          if (this._shouldSkipDomain(source.link)) {
            console.log('[Scraper] Skipping blocked/reference domain:', source.link);
            return this._fallback(source, index);
          }

          // STEP 1: Check if URL contains doi.org
          const isDOIorg = source.link.includes('doi.org/');
          
          if (isDOIorg) {
            const doiData = await DoiAPI.resolve(source.link, source.snippet);
            if (doiData) {
              console.log('[Scraper] DOI.org source:', source.link);
              return {
                ...source,
                id: index + 1,
                title: doiData.title,
                content: doiData.abstract || source.snippet || '',
                doi: doiData.doi,
                meta: {
                  author: this._formatAuthors(doiData.authors),
                  authors: doiData.authors,
                  year: doiData.year,
                  published: doiData.year,
                  siteName: doiData.journal,
                  isDOI: true
                }
              };
            }
          }
          
          // STEP 2: For all other sites, scrape HTML
          console.log('[Scraper] Scraping:', source.link);
          return await this._scrapeHTML(source, index);
          
        } catch (e) {
          console.error('[Scraper] Error:', source.link, e.message);
          return this._fallback(source, index);
        }
      })
    );
    
    return results;
  },

  /**
   * Check if domain is known to block scraping or is reference-only
   */
  _shouldSkipDomain(url) {
    try {
      const hostname = new URL(url).hostname.replace('www.', '').toLowerCase();
      
      // Check hard-blocked domains
      if (BLOCKED_DOMAINS.has(hostname)) {
        return true;
      }
      
      // Check if domain contains reference-only pattern
      for (const blocked of REFERENCE_ONLY_DOMAINS) {
        if (hostname.includes(blocked.toLowerCase())) {
          return true;
        }
      }
      
      return false;
    } catch {
      return false;
    }
  },

  _formatAuthors(authors) {
    if (!authors || authors.length === 0) return null;
    
    if (authors.length === 1) {
      return authors[0].family || authors[0].given || null;
    }
    if (authors.length === 2) {
      return `${authors[0].family} and ${authors[1].family}`;
    }
    return `${authors[0].family} et al.`;
  },

  async _scrapeHTML(source, index) {
    // Skip PDF links
    if (source.link.toLowerCase().endsWith('.pdf') || 
        source.link.includes('/pdf/') ||
        source.link.includes('pdfs.semanticscholar.org')) {
      console.log('[Scraper] Skipping PDF:', source.link);
      return this._fallback(source, index);
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    
    try {
      const res = await fetch(source.link, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.google.com/',
        },
        // Don't follow redirects to avoid infinite loops
        redirect: 'manual'
      });
      
      clearTimeout(timeout);
      
      // Skip if redirected or 403/401
      if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
        console.log('[Scraper] Skipping redirect:', source.link);
        return this._fallback(source, index);
      }
      
      if (res.status === 403 || res.status === 401) {
        console.log('[Scraper] Access denied:', source.link);
        return this._fallback(source, index);
      }
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      
      // Check content type
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('pdf') || contentType.includes('octet-stream')) {
        console.log('[Scraper] Binary content:', source.link);
        return this._fallback(source, index);
      }
      
      const html = await res.text();
      
      // Check if content looks like binary/PDF
      if (html.startsWith('%PDF') || html.substring(0, 100).includes('\x00')) {
        console.log('[Scraper] Detected binary content:', source.link);
        return this._fallback(source, index);
      }
      
      // Try to extract DOI from HTML
      const doiInHtml = this._extractDoiFromHtml(html);
      if (doiInHtml) {
        const doiData = await DoiAPI.fetchFromCrossref(doiInHtml);
        if (doiData) {
          console.log('[Scraper] Found DOI in HTML:', doiInHtml);
          return {
            ...source,
            id: index + 1,
            title: doiData.title,
            content: doiData.abstract || this._extractContent(html) || source.snippet || '',
            doi: doiData.doi,
            meta: {
              author: this._formatAuthors(doiData.authors),
              authors: doiData.authors,
              year: doiData.year,
              published: doiData.year,
              siteName: doiData.journal,
              isDOI: true
            }
          };
        }
      }
      
      // Extract metadata from HTML
      const meta = this._extractMeta(html, source.link);
      const content = this._extractContent(html);
      
      return {
        ...source,
        id: index + 1,
        content: content || source.snippet || '',
        meta: meta
      };
      
    } catch (e) {
      clearTimeout(timeout);
      
      // Timeout or network error
      if (e.message.includes('abort') || e.message.includes('timeout')) {
        console.warn('[Scraper] Timeout:', source.link);
      } else {
        console.error('[Scraper] Fetch error:', source.link, e.message);
      }
      
      return this._fallback(source, index);
    }
  },

  _extractDoiFromHtml(html) {
    const patterns = [
      /<meta[^>]*name=["']citation_doi["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']citation_doi["']/i,
      /<meta[^>]*name=["']dc\.identifier["'][^>]*content=["'](10\.[^"']+)["']/i,
      /doi\.org\/(10\.\d{4,}\/[^\s"'<>\]]+)/i,
      /"doi"\s*:\s*"(10\.[^"]+)"/i,
      /DOI:\s*(10\.\d{4,}\/[^\s<]+)/i
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        let doi = match[1]
          .replace(/^https?:\/\/doi\.org\//i, '')
          .replace(/[.,;)}\]]+$/, '');
        if (doi.startsWith('10.')) {
          return doi;
        }
      }
    }
    return null;
  },

  _extractMeta(html, url) {
    let author = null;
    let year = 'n.d.';
    let siteName = null;
    
    // === AUTHOR EXTRACTION ===
    
    // 1. JSON-LD (most reliable)
    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const data = JSON.parse(jsonLdMatch[1]);
        const items = data['@graph'] || [data];
        
        for (const item of items) {
          if (item.author) {
            if (Array.isArray(item.author)) {
              const names = item.author.map(a => a.name || a).filter(Boolean);
              author = names[0];
            } else if (typeof item.author === 'object') {
              author = item.author.name;
            } else {
              author = item.author;
            }
          }
          if (item.datePublished && year === 'n.d.') {
            const match = item.datePublished.match(/\b(20\d{2})\b/);
            if (match) year = match[1];
          }
          if (item.publisher?.name && !siteName) {
            siteName = item.publisher.name;
          }
        }
      } catch {}
    }
    
    // 2. Meta tags
    if (!author) {
      const authorMeta = html.match(/<meta[^>]*name=["'](?:author|citation_author|dc\.creator)["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["'](?:author|citation_author)["']/i);
      if (authorMeta) author = authorMeta[1];
    }
    
    if (year === 'n.d.') {
      const dateMeta = html.match(/<meta[^>]*(?:name|property)=["'](?:article:published_time|citation_publication_date|date|DC\.date)["'][^>]*content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["'](?:article:published_time|citation_publication_date)["']/i);
      if (dateMeta) {
        const match = dateMeta[1].match(/\b(20\d{2})\b/);
        if (match) year = match[1];
      }
    }
    
    if (!siteName) {
      const siteMatch = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i) ||
                       html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
      if (siteMatch) siteName = siteMatch[1];
    }
    
    // 3. Site name from URL if missing
    if (!siteName) {
      try {
        const hostname = new URL(url).hostname.replace('www.', '');
        const parts = hostname.split('.');
        siteName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      } catch {}
    }
    
    // === CLEAN UP ===
    
    // Validate author
    if (author) {
      author = author
        .replace(/^(By|Written by|Author:)\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      
      const invalid = /^(default|unknown|admin|editor|staff|https?:|www\.|[^a-zA-Z]{3,})/i;
      if (invalid.test(author) || author.length < 3 || author.length > 60) {
        author = null;
      }
    }
    
    return {
      author: author,
      year: year,
      published: year,
      siteName: siteName || 'Unknown'
    };
  },

  _extractContent(html) {
    let clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '');
    
    const articleMatch = clean.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                        clean.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                        clean.match(/<div[^>]*class="[^"]*(?:content|article|post)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    
    if (articleMatch) {
      clean = articleMatch[1];
    }
    
    const text = clean
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    
    return text.substring(0, 1500);
  },

  _fallback(source, index) {
    let siteName = 'Unknown';
    try {
      const hostname = new URL(source.link).hostname.replace('www.', '');
      siteName = hostname.split('.')[0];
      siteName = siteName.charAt(0).toUpperCase() + siteName.slice(1);
    } catch {}
    
    return {
      ...source,
      id: index + 1,
      content: source.snippet || '',
      meta: {
        author: null,
        year: 'n.d.',
        published: 'n.d.',
        siteName: siteName
      }
    };
  }
};
