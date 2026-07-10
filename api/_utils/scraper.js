// ==========================================================================
// FILE PATH: api/_utils/scraper.js
// ==========================================================================

/**
 * api/_utils/scraper.js
 * Scrapes web pages for citation metadata, prioritizing DOI when available
 * 
 * Table of Contents:
 * 1. Main Source Scraper Module
 * 2. HTML Scraper & Parser Module
 * 3. Metadata Extraction Module
 * 4. Content Extractor & Cleaners Module
 */

import { DoiAPI } from './doiAPI.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ==========================================================================
// MODULE 1: Main Source Scraper
// ==========================================================================
export const ScraperAPI = {
    async scrape(sources) {
        const results = await Promise.all(
            sources.slice(0, 20).map(async (source, index) => {
                try {
                    // Extract DOI directly from link/snippet (completely avoids Cloudflare 403 blocks)
                    const doi = DoiAPI.extractDOI(source.link) || DoiAPI.extractDOI(source.snippet);
                    
                    if (doi) {
                        const doiData = await DoiAPI.resolve(source.link, source.snippet);
                        if (doiData) {
                            console.log('[Scraper] Programmatic DOI resolved:', doi);
                            return {
                                ...source,
                                id: index + 1,
                                title: doiData.title,
                                content: doiData.abstract || source.snippet || '',
                                doi: doiData.doi,
                                meta: {
                                    authors: doiData.authors,
                                    year: doiData.year,
                                    published: doiData.year,
                                    siteName: doiData.journal,
                                    isDOI: true
                                }
                            };
                        }
                    }
                    
                    // Fall back to web HTML scrape only if DOI resolution fails
                    console.log('[Scraper] HTML Scraping:', source.link);
                    return await this._scrapeHTML(source, index);
                    
                } catch (e) {
                    console.error('[Scraper] Error:', source.link, e.message);
                    return this._fallback(source, index);
                }
            })
        );
        return results;
    },

// ==========================================================================
// MODULE 2: HTML Scraper & Parser
// ==========================================================================
    async _scrapeHTML(source, index) {
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
                    'Accept': 'text/html,application/xhtml+xml'
                }
            });
            clearTimeout(timeout);
            
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('pdf') || contentType.includes('octet-stream')) {
                console.log('[Scraper] Skipping binary content:', source.link);
                return this._fallback(source, index);
            }
            
            const html = await res.text();
            
            // Binary signatures check
            if (html.startsWith('%PDF') || html.substring(0, 100).includes('\x00')) {
                console.log('[Scraper] Detected binary content:', source.link);
                return this._fallback(source, index);
            }
            
            // Scan HTML context for hidden DOIs
            const doiInHtml = this._extractDoiFromHtml(html);
            if (doiInHtml) {
                const doiData = await DoiAPI.resolve(doiInHtml);
                if (doiData) {
                    console.log('[Scraper] Found DOI in HTML content:', doiInHtml);
                    return {
                        ...source,
                        id: index + 1,
                        title: doiData.title,
                        content: doiData.abstract || this._extractContent(html) || source.snippet || '',
                        doi: doiData.doi,
                        meta: {
                            authors: doiData.authors,
                            year: doiData.year,
                            published: doiData.year,
                            siteName: doiData.journal,
                            isDOI: true
                        }
                    };
                }
            }
            
            return {
                ...source,
                id: index + 1,
                content: this._extractContent(html) || source.snippet || '',
                meta: this._extractMeta(html, source.link)
            };
        } catch (e) {
            clearTimeout(timeout);
            throw e;
        }
    },

// ==========================================================================
// MODULE 3: Metadata Extraction
// ==========================================================================
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
                const doi = match[1].replace(/^https?:\/\/doi\.org\//i, '').replace(/[.,;)}\]]+$/, '');
                if (doi.startsWith('10.')) return doi;
            }
        }
        return null;
    },

    _extractMeta(html, url) {
        let author = null;
        let year = 'n.d.';
        let siteName = null;
        
        // JSON-LD Metadata parsing
        const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
        if (jsonLdMatch) {
            try {
                const data = JSON.parse(jsonLdMatch[1]);
                const items = data['@graph'] || [data];
                
                for (const item of items) {
                    if (item.author) {
                        author = Array.isArray(item.author)
                            ? item.author.map(a => a.name || a).filter(Boolean)[0]
                            : (typeof item.author === 'object' ? item.author.name : item.author);
                    }
                    if (item.datePublished && year === 'n.d.') {
                        const match = item.datePublished.match(/\b(20\d{2})\b/);
                        if (match) year = match[1];
                    }
                    if (item.publisher?.name && !siteName) siteName = item.publisher.name;
                }
            } catch {}
        }
        
        // Meta tags fallbacks
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
        
        // General Domain Fallback
        if (!siteName) {
            try {
                const hostname = new URL(url).hostname.replace('www.', '');
                siteName = hostname.split('.')[0];
                siteName = siteName.charAt(0).toUpperCase() + siteName.slice(1);
            } catch {}
        }
        
        return {
            author: DoiAPI.cleanAuthorName(author),
            year: year,
            published: year,
            siteName: siteName || 'Unknown'
        };
    },

// ==========================================================================
// MODULE 4: Content Extractor & Cleaners
// ==========================================================================
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
        
        if (articleMatch) clean = articleMatch[1];
        
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
