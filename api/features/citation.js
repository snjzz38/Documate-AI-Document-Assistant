// api/features/citation.js
import { GoogleSearchAPI } from '../_utils/googleSearch.js';
import { ScraperAPI } from '../_utils/scraper.js';
import { GroqAPI } from '../_utils/groqAPI.js';

const TODAY = () => new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

// ==========================================================================
// AUTHOR NAME CLEANING - Fixes junk author names
// ==========================================================================
function cleanAuthorName(author, source) {
    if (!author) return null;
    
    const str = String(author).trim();
    
    // List of invalid author patterns
    const invalidPatterns = [
        /^https?:\/\//i,           // URLs
        /facebook\.com/i,
        /twitter\.com/i,
        /^www\./i,
        /^default$/i,
        /^unknown$/i,
        /^admin$/i,
        /^editor$/i,
        /^staff$/i,
        /^contributor$/i,
        /^pmc\.?$/i,
        /^ncbi/i,
        /^\d+$/,                   // Just numbers
        /^[^a-zA-Z]*$/,            // No letters
        /→|►|→|View all/i,         // Navigation elements
    ];
    
    for (const pattern of invalidPatterns) {
        if (pattern.test(str)) return null;
    }
    
    // Too short or too long
    if (str.length < 3 || str.length > 80) return null;
    
    // Clean up common prefixes
    let cleaned = str
        .replace(/^(By|Written by|Author:|Posted by)\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    
    return cleaned || null;
}

function getAuthorName(source) {
    // 1. Try DOI metadata (most reliable)
    if (source.meta?.isDOI && source.meta?.authors?.length > 0) {
        const authors = source.meta.authors;
        if (authors.length === 1) return authors[0].family || authors[0].given || null;
        if (authors.length === 2) return `${authors[0].family} and ${authors[1].family}`;
        return `${authors[0].family} et al.`;
    }
    
    // 2. Try scraped author (with validation)
    const cleanedAuthor = cleanAuthorName(source.meta?.author, source);
    if (cleanedAuthor) {
        // Get last name for in-text citation
        if (cleanedAuthor.includes(',')) {
            return cleanedAuthor.split(',')[0].trim();
        }
        const parts = cleanedAuthor.split(/\s+/).filter(p => p.length > 1);
        if (parts.length >= 2) {
            return parts[parts.length - 1]; // Last name
        }
        return cleanedAuthor;
    }
    
    // 3. Fallback to cleaned site name
    return cleanSiteName(source.meta?.siteName || source.title);
}

function cleanSiteName(site) {
    if (!site) return 'Unknown';
    
    let cleaned = String(site)
        .replace(/^www\./, '')
        .replace(/^https?:\/\//, '')
        .replace(/\.(com|org|edu|net|gov|io|health)$/i, '')
        .replace(/[→\-–|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    // Get first meaningful part
    const parts = cleaned.split(/[.\s]/);
    const meaningful = parts.find(p => p.length > 2 && !/^(www|http|https)$/i.test(p));
    
    if (meaningful) {
        // Capitalize properly
        return meaningful.charAt(0).toUpperCase() + meaningful.slice(1).toLowerCase();
    }
    
    return cleaned || 'Unknown';
}

function getYear(source) {
    // Try meta.year first
    const y = source.meta?.year;
    if (y && y !== 'n.d.' && /^\d{4}$/.test(String(y))) {
        return String(y);
    }
    
    // Try to extract from published date
    if (source.meta?.published && source.meta.published !== 'n.d.') {
        const match = source.meta.published.match(/\b(19|20)\d{2}\b/);
        if (match) return match[0];
    }
    
    // Try to extract from content or snippet
    const text = (source.content || '') + (source.snippet || '');
    const contentMatch = text.match(/\b(202[0-6]|201\d|200\d)\b/);
    if (contentMatch) return contentMatch[0];
    
    return 'n.d.';
}

// Format in-text citation: (Author Year)
function formatInText(source, style) {
    const author = getAuthorName(source);
    const year = getYear(source);
    const s = String(style || 'chicago').toLowerCase();
    
    if (s.includes('mla')) {
        return `(${author})`;
    }
    if (s.includes('apa')) {
        return `(${author}, ${year})`;
    }
    // Chicago default
    return `(${author} ${year})`;
}

// Format bibliography entry
function formatBib(source, style) {
    const s = String(style || 'chicago').toLowerCase();
    const year = getYear(source);
    const site = cleanSiteName(source.meta?.siteName || source.title);
    const today = TODAY();
    
    // Get full author name for bibliography
    let author;
    if (source.meta?.isDOI && source.meta?.authors?.length > 0) {
        const authors = source.meta.authors;
        if (authors.length === 1) {
            author = `${authors[0].family}, ${authors[0].given}`;
        } else if (authors.length === 2) {
            author = `${authors[0].family}, ${authors[0].given}, and ${authors[1].given} ${authors[1].family}`;
        } else {
            author = `${authors[0].family}, ${authors[0].given}, et al.`;
        }
    } else {
        const cleanedAuthor = cleanAuthorName(source.meta?.author, source);
        author = cleanedAuthor || site;
    }

    const url = source.doi ? `https://doi.org/${source.doi}` : source.link;
    const title = source.title || 'Untitled';

    if (s.includes('apa')) {
        return `${author}. (${year}). ${title}. *${site}*. ${url}`;
    }
    if (s.includes('mla')) {
        return `${author}. "${title}." *${site}*, ${year}, ${url}.`;
    }
    // Chicago
    return `${author}. "${title}." *${site}*. ${year}. ${url} (Accessed ${today})`;
}

// ==========================================================================
// PROCESS INSERTIONS
// ==========================================================================
function processInsertions(text, insertions, sources, style, outputType) {
    let result = text;
    const used = new Set();
    const footnotes = [];
    let fnNum = 1;

    // Tokenize
    const tokens = [];
    const re = /[a-z0-9]+/gi;
    let m;
    while ((m = re.exec(text))) {
        tokens.push({ word: m[0].toLowerCase(), end: m.index + m[0].length });
    }

    // Find positions
    const valid = insertions.map(ins => {
        if (!ins.anchor || !ins.source_id) return null;
        const words = ins.anchor.toLowerCase().match(/[a-z0-9]+/g);
        if (!words || words.length < 2) return null;
        
        for (let i = 0; i <= tokens.length - words.length; i++) {
            if (words.every((w, j) => tokens[i + j].word === w)) {
                return { sourceId: ins.source_id, pos: tokens[i + words.length - 1].end };
            }
        }
        return null;
    }).filter(Boolean);

    // Dedupe by position
    const byPos = new Map();
    valid.forEach(v => {
        if (!byPos.has(v.pos)) byPos.set(v.pos, v.sourceId);
    });

    // Build citations
    const positions = [...byPos.keys()].sort((a, b) => a - b);
    const posData = new Map();

    positions.forEach(pos => {
        const src = sources.find(s => s.id === byPos.get(pos));
        if (!src) return;
        used.add(src.id);

        if (outputType === 'footnotes') {
            footnotes.push({ num: fnNum, cit: formatBib(src, style) });
            posData.set(pos, { type: 'fn', num: fnNum++ });
        } else {
            posData.set(pos, { type: 'it', cit: formatInText(src, style) });
        }
    });

    // Insert (reverse order to preserve positions)
    const toSuper = n => n.toString().split('').map(d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d]).join('');
    
    [...positions].reverse().forEach(pos => {
        const d = posData.get(pos);
        if (!d) return;
        const insert = d.type === 'fn' ? toSuper(d.num) : ` ${d.cit}`;
        result = result.slice(0, pos) + insert + result.slice(pos);
    });

    // Footer
    let footer = '\n\n';
    if (outputType === 'footnotes') {
        // FOOTNOTES: Keep in order of appearance (by footnote number)
        footer += '### Footnotes\n\n';
        footnotes.forEach(f => footer += `${f.num}. ${f.cit}\n\n`);
    } else {
        // IN-TEXT / BIBLIOGRAPHY: Sort alphabetically by author
        footer += '### References\n\n';
        const usedSources = sources.filter(s => used.has(s.id));
        
        // Sort by author name alphabetically
        usedSources.sort((a, b) => {
            const authorA = getAuthorName(a).toLowerCase();
            const authorB = getAuthorName(b).toLowerCase();
            return authorA.localeCompare(authorB);
        });
        
        usedSources.forEach(s => {
            footer += formatBib(s, style) + '\n\n';
        });
    }

    // Further Reading also alphabetically
    const unused = sources.filter(s => !used.has(s.id));
    if (unused.length) {
        footer += '\n### Further Reading\n\n';
        
        // Sort unused sources alphabetically too
        unused.sort((a, b) => {
            const authorA = getAuthorName(a).toLowerCase();
            const authorB = getAuthorName(b).toLowerCase();
            return authorA.localeCompare(authorB);
        });
        
        unused.forEach(s => footer += formatBib(s, style) + '\n\n');
    }

    footer += `\n---\n*${used.size}/${sources.length} sources cited*`;

    return result + footer;
}

// ==========================================================================
// PROMPT FOR GROQ
// ==========================================================================
function buildPrompt(text, sources) {
    const srcList = sources.map(s => {
        const author = getAuthorName(s);
        const year = getYear(s);
        return `[${s.id}] ${author} (${year}) - ${s.title.substring(0, 50)}`;
    }).join('\n');

    return `Find citation insertion points in this text. Use 8+ sources.

SOURCES:
${srcList}

TEXT:
"${text}"

Return JSON only:
{"insertions":[{"anchor":"3-6 exact words from text","source_id":1}]}

Rules:
- anchor = exact consecutive words from the text
- Create 10+ insertions across all paragraphs
- Distribute sources evenly`;
}

// ==========================================================================
// HANDLER
// ==========================================================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { context, style = 'Chicago', outputType = 'in-text', apiKey, googleKey, preLoadedSources } = req.body;
        const GROQ = apiKey || process.env.GROQ_API_KEY;
        const GKEY = googleKey || process.env.GOOGLE_SEARCH_API_KEY;
        const GCX = process.env.SEARCH_ENGINE_ID;

        // QUOTES MODE — no search performed; no stats to report
        if (preLoadedSources?.length) {
            const sourcesWithContent = await Promise.all(preLoadedSources.map(async (s) => {
                if (!s.content || s.content.length < 200) {
                    try {
                        const scraped = await ScraperAPI.scrape([s]);
                        return scraped[0] || s;
                    } catch { return s; }
                }
                return s;
            }));

            const srcList = sourcesWithContent.map((s, i) => {
                const content = (s.content || s.snippet || '').substring(0, 1500);
                return `[${i + 1}] ${s.title}\nURL: ${s.link}\nCONTENT:\n${content}`;
            }).join('\n\n---\n\n');

            const prompt = `Extract 1-3 verbatim quotes from EACH source.

SOURCES:
${srcList}

RULES:
1. Quotes must be EXACT text from CONTENT - word for word
2. Each quote: 1-4 sentences
3. Use FULL URL provided
4. Skip sources with no usable content

FORMAT:
**[1] Title** - URL
> "Exact quote..."`;

            let result = await GroqAPI.chat([{ role: 'user', content: prompt }], GROQ, false);
            return res.status(200).json({ 
                success: true, 
                text: result,
                citations: sourcesWithContent,
                stats: null,
                count: sourcesWithContent.length
            });
        }

        // SEARCH & SCRAPE
        console.log('[Citation] Starting search...');
        const raw = await GoogleSearchAPI.search(context, GKEY, GCX, GROQ);
        console.log('[Citation] Search returned:', raw?.length || 0, 'results');
        
        if (!raw || raw.length === 0) {
            return res.status(200).json({ 
                success: false, 
                error: 'No search results. The search service may be temporarily unavailable.',
                sources: [],
                text: '',
                citations: [],
                stats: raw?.stats || null,
                count: 0
            });
        }
        
        const sources = await ScraperAPI.scrape(raw);
        console.log('[Citation] Scraped:', sources?.length || 0, 'sources');

        // BIBLIOGRAPHY MODE - dedupe by DOI or URL
        if (outputType === 'bibliography') {
            const seen = new Set();
            const uniqueSources = sources.filter(s => {
                const key = s.doi || s.link;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            const bibs = uniqueSources.map(s => formatBib(s, style)).join('\n\n');
            return res.status(200).json({ 
                success: true, 
                sources: uniqueSources, 
                text: bibs,
                citations: uniqueSources,
                stats: raw.stats,
                count: uniqueSources.length
            });
        }

        // CITATION MODE
        const prompt = buildPrompt(context, sources);
        const response = await GroqAPI.chat([{ role: 'user', content: prompt }], GROQ, true);
        
        let insertions = [];
        try {
            const json = response.match(/\{[\s\S]*\}/)?.[0];
            insertions = json ? JSON.parse(json).insertions || [] : [];
        } catch (e) {
            console.error('[Citation] JSON parse error:', e.message);
        }

        const result = processInsertions(context, insertions, sources, style, outputType);
        return res.status(200).json({ 
            success: true, 
            sources, 
            text: result,
            citations: sources,
            stats: raw.stats,
            count: sources.length
        });

    } catch (error) {
        console.error('[Citation] Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}
