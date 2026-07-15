// ==========================================================================
// FILE PATH: api/features/citation.js
// ==========================================================================

/*
 * TABLE OF CONTENTS
 * -------------------------------------------------------
 * 1. DEPENDENCIES & CONFIGURATION
 * 2. AUTHOR & METADATA CLEANING
 *    - cleanAuthorName, getAuthorName, cleanSiteName, getYear
 * 3. CITATION FORMATTING
 *    - formatInText, formatBib
 * 4. INSERTION PROCESSING
 *    - processInsertions
 * 5. PROMPT BUILDING
 *    - buildPrompt
 * 6. MAIN HANDLER
 *    - handler()
 */


// ==========================================================================
// MODULE 1: DEPENDENCIES & CONFIGURATION
// ==========================================================================

import { OpenalexAPI } from '../_utils/openalex.js'; // Renamed from GoogleSearchAPI
import { SearxAPI } from '../_utils/searx.js'; // Added SearXNG import for general search
import { ScraperAPI } from '../_utils/scraper.js';
import { GroqAPI } from '../_utils/groqAPI.js';
import { DoiAPI } from '../_utils/doiAPI.js';

const TODAY = () => new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });


// ════════════════════════════════════════════════════════════════════════════
// MODULE 2: AUTHOR & METADATA CLEANING
// ════════════════════════════════════════════════════════════════════════════

function cleanAuthorName(author, source) {
    if (!author) return null;
    const str = String(author).trim();
    const invalidPatterns = [
        /^https?:\/\//i, /facebook\.com/i, /twitter\.com/i, /^www\./i,
        /^default$/i, /^unknown$/i, /^admin$/i, /^editor$/i, /^staff$/i,
        /^contributor$/i, /^pmc\.?$/i, /^ncbi/i, /^\d+$/, /^[^a-zA-Z]*$/,
        /→|►|→|View all/i, /^doi$/i, /^n\.?d\.?$/i
    ];
    
    for (const pattern of invalidPatterns) {
        if (pattern.test(str)) return null;
    }
    if (str.length < 3 || str.length > 80) return null;
    
    let cleaned = str.replace(/^(By|Written by|Author:|Posted by)\s*/i, '').replace(/\s+/g, ' ').trim();
    return cleaned || null;
}

function getAuthorName(source) {
    if (source.meta?.isDOI && source.meta?.authors?.length > 0) {
        const authors = source.meta.authors;
        if (authors.length === 1) return authors[0].family || authors[0].given || null;
        if (authors.length === 2) return `${authors[0].family} and ${authors[1].family}`;
        return `${authors[0].family} et al.`;
    }
    
    const cleanedAuthor = cleanAuthorName(source.meta?.author, source);
    if (cleanedAuthor) {
        if (cleanedAuthor.includes(',')) return cleanedAuthor.split(',')[0].trim();
        const parts = cleanedAuthor.split(/\s+/).filter(p => p.length > 1);
        if (parts.length >= 2) return parts[parts.length - 1];
        return cleanedAuthor;
    }
    
    return cleanSiteName(source.meta?.siteName || source.title);
}

function cleanSiteName(site) {
    if (!site) return 'Unknown';
    let cleaned = String(site).replace(/^www\./, '').replace(/^https?:\/\//, '')
        .replace(/\.(com|org|edu|net|gov|io|health)$/i, '').replace(/[→\-–|]/g, ' ')
        .replace(/\s+/g, ' ').trim();
    
    if (cleaned.includes(' ') && cleaned.length > 5) {
        return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    }

    const parts = cleaned.split(/[.\s]/);
    const meaningful = parts.find(p => p.length > 2 && !/^(www|http|https|doi)$/i.test(p));
    return meaningful ? meaningful.charAt(0).toUpperCase() + meaningful.slice(1).toLowerCase() : 'Unknown';
}

function getYear(source) {
    const y = source.meta?.year;
    if (y && y !== 'n.d.' && /^\d{4}$/.test(String(y))) return String(y);
    if (source.meta?.published && source.meta.published !== 'n.d.') {
        const match = source.meta.published.match(/\b(19|20)\d{2}\b/);
        if (match) return match[0];
    }
    const text = (source.content || '') + (source.snippet || '');
    const contentMatch = text.match(/\b(202[0-6]|201\d|200\d)\b/);
    return contentMatch ? contentMatch[0] : 'n.d.';
}


// ════════════════════════════════════════════════════════════════════════════
// MODULE 3: ACADEMIC CITATION FORMATTING (APA, MLA, CHICAGO)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Format authors strictly according to APA 7th Edition rules (Initials + Ampersands)
 */
function formatAPAAuthors(authors) {
    if (!authors || !Array.isArray(authors) || authors.length === 0) return null;
    
    const formatted = authors.map(a => {
        const family = (a.family || '').trim();
        const given = (a.given || '').trim();
        if (!family) return '';
        
        // Convert given names to capitalized initials (e.g., "Hanna Bertilsdotter" -> "H. B.")
        const initials = given
            ? given.split(/[\s-]+/).map(part => `${part[0].toUpperCase()}.`).join(' ')
            : '';
        return initials ? `${family}, ${initials}` : family;
    }).filter(Boolean);

    if (formatted.length === 0) return null;
    if (formatted.length === 1) return formatted[0];
    if (formatted.length === 2) return `${formatted[0]}, & ${formatted[1]}`;
    
    // APA 7 supports listing up to 20 authors before using ellipses
    if (formatted.length <= 20) {
        return formatted.slice(0, -1).join(', ') + `, & ${formatted[formatted.length - 1]}`;
    }
    return formatted.slice(0, 19).join(', ') + ', ... ' + formatted[formatted.length - 1];
}

/**
 * Format authors for MLA / Chicago Style (First Author Reversed, rest natural)
 */
function formatStandardAuthors(authors, useAnd = true) {
    if (!authors || !Array.isArray(authors) || authors.length === 0) return null;
    
    const formatted = authors.map((a, i) => {
        const family = (a.family || '').trim();
        const given = (a.given || '').trim();
        if (!family) return '';
        
        if (i === 0) {
            // First author reversed: "Stenning, Anna"
            return given ? `${family}, ${given}` : family;
        } else {
            // Subsequent authors natural: "Hanna Bertilsdotter Rosqvist"
            return given ? `${given} ${family}` : family;
        }
    }).filter(Boolean);

    const amp = useAnd ? 'and' : '&';
    if (formatted.length === 0) return null;
    if (formatted.length === 1) return formatted[0];
    if (formatted.length === 2) return `${formatted[0]} ${amp} ${formatted[1]}`;
    return formatted.slice(0, -1).join(', ') + `, ${amp} ${formatted[formatted.length - 1]}`;
}

/**
 * Capitalizes a string to Title Case (for APA Journal Titles)
 */
function toTitleCase(str) {
    if (!str) return '';
    const minorWords = /^(a|an|the|and|but|or|for|nor|on|in|at|by|to|for|of|with|about|as)$/i;
    return str.split(/\s+/).map((word, index) => {
        if (index > 0 && minorWords.test(word)) return word.toLowerCase();
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
}

function formatInText(source, style) {
    const s = String(style || 'chicago').toLowerCase();
    const year = getYear(source);
    
    let authorName = '';
    if (source.meta?.isDOI && source.meta?.authors?.length > 0) {
        const firstAuthor = source.meta.authors[0];
        authorName = firstAuthor.family || cleanSiteName(source.meta?.siteName || source.title);
        
        if (source.meta.authors.length === 2) {
            const secondAuthor = source.meta.authors[1];
            authorName += s.includes('apa') ? ` & ${secondAuthor.family}` : ` and ${secondAuthor.family}`;
        } else if (source.meta.authors.length > 2) {
            authorName += ' et al.';
        }
    } else {
        authorName = cleanAuthorName(source.meta?.author, source) || cleanSiteName(source.meta?.siteName || source.title);
    }
    
    if (s.includes('mla')) return `(${authorName})`;
    if (s.includes('apa')) return `(${authorName}, ${year})`;
    return `(${authorName} ${year})`;
}

function formatBib(source, style) {
    const s = String(style || 'chicago').toLowerCase();
    const year = getYear(source);
    const site = cleanSiteName(source.meta?.siteName || source.title);
    const url = source.doi ? `https://doi.org/${source.doi}` : source.link;
    const title = source.title || 'Untitled';
    const today = TODAY();

    // Pull journal metadata if extracted by DoiAPI
    const volume = source.meta?.volume || source.volume || null;
    const issue = source.meta?.issue || source.issue || null;
    const pages = source.meta?.pages || source.pages || null;

    let author;
    const hasDoiAuthors = !!(source.meta?.isDOI && source.meta?.authors?.length > 0);

    if (s.includes('apa')) {
        author = hasDoiAuthors
            ? formatAPAAuthors(source.meta.authors)
            : (cleanAuthorName(source.meta?.author, source) || site);
            
        const cleanSite = toTitleCase(site);
        
        // Build APA 7 Journal specs: Volume(Issue), Pages
        let journalSpecs = '';
        if (volume) {
            journalSpecs += `, *${volume}*`;
            if (issue) journalSpecs += `(${issue})`;
        }
        if (pages) {
            journalSpecs += `, ${pages}`;
        }

        return `${author}. (${year}). ${title}. *${cleanSite}*${journalSpecs}. ${url}`;
    }

    if (s.includes('mla')) {
        author = hasDoiAuthors
            ? formatStandardAuthors(source.meta.authors, true)
            : (cleanAuthorName(source.meta?.author, source) || site);

        // Build MLA container specifications
        let containerSpecs = '';
        if (volume) containerSpecs += `, vol. ${volume}`;
        if (issue) containerSpecs += `, no. ${issue}`;
        if (pages) containerSpecs += `, pp. ${pages}`;

        return `${author}. "${title}." *${site}*${containerSpecs}, ${year}, ${url}.`;
    }

    // Chicago Notes-Bibliography fallback
    author = hasDoiAuthors
        ? formatStandardAuthors(source.meta.authors, true)
        : (cleanAuthorName(source.meta?.author, source) || site);

    let chicagoSpecs = '';
    if (volume) {
        chicagoSpecs += ` ${volume}`;
        if (issue) chicagoSpecs += `, no. ${issue}`;
    }
    if (pages) {
        chicagoSpecs += ` (${year}): ${pages}`;
    } else {
        chicagoSpecs += ` (${year})`;
    }

    return `${author}. "${title}." *${site}*${chicagoSpecs}. ${url} (Accessed ${today})`;
}


// ==========================================================================
// MODULE 4: INSERTION PROCESSING
// ==========================================================================

/**
 * Universal alphabetical sorting helper (Primary Author Family Name -> Site Fallback -> Title)
 */
function sortSourcesAlphabetically(srcList) {
    if (!srcList || !Array.isArray(srcList)) return [];
    return srcList.sort((a, b) => {
        let nameA = '';
        if (a.meta?.isDOI && a.meta?.authors?.length > 0) {
            nameA = a.meta.authors[0].family;
        } else {
            nameA = DoiAPI.cleanAuthorName(a.meta?.author);
        }
        if (!nameA) {
            nameA = DoiAPI.cleanSiteName(a.meta?.siteName || a.title);
        }

        let nameB = '';
        if (b.meta?.isDOI && b.meta?.authors?.length > 0) {
            nameB = b.meta.authors[0].family;
        } else {
            nameB = DoiAPI.cleanAuthorName(b.meta?.author);
        }
        if (!nameB) {
            nameB = DoiAPI.cleanSiteName(b.meta?.siteName || b.title);
        }

        return nameA.toLowerCase().localeCompare(nameB.toLowerCase());
    });
}

function processInsertions(text, insertions, sources, style, outputType, isAgent = false) {
    let result = text;
    const used = new Set();
    const footnotes = [];
    let fnNum = 1;

    const tokens = [];
    const re = /[a-z0-9]+/gi;
    let m;
    while ((m = re.exec(text))) {
        tokens.push({ word: m[0].toLowerCase(), end: m.index + m[0].length });
    }

    const claimedIndices = new Set();

    const valid = insertions.map(ins => {
        if (!ins.anchor || !ins.source_id) return null;
        const words = ins.anchor.toLowerCase().match(/[a-z0-9]+/g);
        if (!words || words.length < 2) return null;
        for (let i = 0; i <= tokens.length - words.length; i++) {
            if (claimedIndices.has(i)) continue;
            
            const isMatch = words.every((w, j) => tokens[i + j].word === w);
            if (isMatch) {
                for (let k = 0; k < words.length; k++) claimedIndices.add(i + k);
                return { sourceId: ins.source_id, pos: tokens[i + words.length - 1].end };
            }
        }

        // Fuzzy fallback match (tolerates 1 minor word deviation)
        if (words.length >= 4) {
            for (let i = 0; i <= tokens.length - words.length; i++) {
                if (claimedIndices.has(i)) continue;

                let mismatches = 0;
                for (let j = 0; j < words.length; j++) {
                    if (tokens[i + j].word !== words[j]) mismatches++;
                }

                if (mismatches <= 1) {
                    for (let k = 0; k < words.length; k++) claimedIndices.add(i + k);
                    return { sourceId: ins.source_id, pos: tokens[i + words.length - 1].end };
                }
            }
        }
        return null;
    }).filter(Boolean);

    const byPos = new Map();
    valid.forEach(v => { if (!byPos.has(v.pos)) byPos.set(v.pos, v.sourceId); });

    const sortedPositions = [...byPos.keys()].sort((a, b) => a - b);
    const posData = new Map();

    sortedPositions.forEach(pos => {
        const src = sources.find(s => s.id === byPos.get(pos));
        if (!src) return;
        used.add(src.id);
        if (outputType === 'footnotes') {
            footnotes.push({ num: fnNum, cit: DoiAPI.formatBib(src, style) });
            posData.set(pos, { type: 'fn', num: fnNum++ });
        } else {
            posData.set(pos, { type: 'it', cit: DoiAPI.formatInText(src, style) });
        }
    });

    const toSuper = n => n.toString().split('').map(d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d]).join('');
    
    // Process positions in reverse order to maintain accurate character indexing
    [...sortedPositions].reverse().forEach(pos => {
        const d = posData.get(pos);
        if (!d) return;

        // Academic Punctuation Look-Ahead
        let adjustedPos = pos;
        while (adjustedPos < text.length && /^[.,;:!?"']/.test(text[adjustedPos])) {
            adjustedPos++;
        }

        const insert = d.type === 'fn' ? toSuper(d.num) : ` ${d.cit}`;
        result = result.slice(0, adjustedPos) + insert + result.slice(adjustedPos);
    });

    // If requested by the Swarm Agent, bypass the appended references footer (kept clean for UI textboxes) [1]
    if (isAgent) {
        return result;
    }

    // Standalone Citation Machine: Generate and append the standard academic footnotes/references footer
    let footer = '\n\n';
    if (outputType === 'footnotes') {
        footer += '### Footnotes\n\n';
        footnotes.forEach(f => footer += `${f.num}. ${f.cit}\n\n`);
    } else {
        footer += '### References\n\n';
        const usedSources = sources.filter(s => used.has(s.id));
        sortSourcesAlphabetically(usedSources);
        usedSources.forEach(s => { footer += DoiAPI.formatBib(s, style) + '\n\n'; });
    }

    const unused = sources.filter(s => !used.has(s.id));
    if (unused.length) {
        footer += '\n### Further Reading\n\n';
        sortSourcesAlphabetically(unused);
        unused.forEach(s => footer += DoiAPI.formatBib(s, style) + '\n\n');
    }

    footer += `\n---\n*${used.size}/${sources.length} sources cited*`;
    return result + footer;
}

// ════════════════════════════════════════════════════════════════════════════
// MODULE 5: PROMPT BUILDING
// ════════════════════════════════════════════════════════════════════════════

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
// MODULE 6: MAIN HANDLER
// ==========================================================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { context, style = 'Chicago', outputType = 'in-text', apiKey, googleKey, preLoadedSources, isAgent = false } = req.body;
        const GROQ = apiKey || process.env.GROQ_API_KEY;
        const GKEY = googleKey || process.env.GOOGLE_SEARCH_API_KEY;
        const GCX = process.env.SEARCH_ENGINE_ID;
        
        const OPENALEX = process.env.OPENALEX_API_KEY;

        // DYNAMIC QUOTES ROUTER — Multi-purpose gate compatible with both manual Sidebar and Swarm Agent contexts [1]
        const isQuotesMode = outputType === 'quotes' || (preLoadedSources?.length && !['in-text', 'footnotes', 'bibliography'].includes(outputType));

        if (isQuotesMode) {
            let targetSources = [];
            
            if (preLoadedSources && Array.isArray(preLoadedSources) && preLoadedSources.length > 0) {
                targetSources = preLoadedSources;
            } else {
                // If no preloaded sources are passed, perform a live targeted search based on the user's argument context [1]
                console.log('[Citation] No pre-loaded sources for quotes. Executing search...');
                const [academicResults, generalResults] = await Promise.all([
                    OpenalexAPI.search(context, GKEY, GCX, GROQ, OPENALEX),
                    SearxAPI.search(context, 5)
                ]);
                const raw = [...academicResults, ...generalResults];
                targetSources = await ScraperAPI.scrape(raw);
            }

            const sourcesWithContent = await Promise.all(targetSources.map(async (s) => {
                const url = s.link || s.url;
                if (!s.content || s.content.length < 200) {
                    try { return (await ScraperAPI.scrape([s]))[0] || s; } 
                    catch { return s; }
                }
                return s;
            }));

            const srcList = sourcesWithContent.map((s, i) => {
                const content = (s.content || s.snippet || '').substring(0, 1500);
                return `[${i + 1}] ${s.title}\nURL: ${s.link || s.url}\nCONTENT:\n${content}`;
            }).join('\n\n---\n\n');

            // Formulate high-relevance prompt to extract quotes aligning with and supporting the user's argument [1]
            const prompt = `You are an academic researcher. Extract exactly 1-2 powerful, direct verbatim quotes from each source's CONTENT that directly align with and support the user's core argument or topic.

USER'S CONTEXT / ARGUMENT:
"${context || 'general research'}"

SOURCES:
${srcList}

RULES:
1. Quotes must be EXACT text from CONTENT - word for word
2. Select quotes that are highly relevant to and support the USER'S CONTEXT above
3. Each quote must be 1-4 sentences
4. Use full URLs provided
5. Skip sources with no usable content

FORMAT:
**[1] Title** - URL
> "Exact quote..."`;

            let result = await GroqAPI.chat([{ role: 'user', content: prompt }], GROQ, false);
            return res.status(200).json({ success: true, text: result, citations: sourcesWithContent, stats: null, count: sourcesWithContent.length });
        }

        // SEARCH & SCRAPE (default Citation mode)
        let sources = [];
        let raw = null;

        // If pre-loaded sources are passed, bypass search and re-use them immediately
        if (preLoadedSources && Array.isArray(preLoadedSources) && preLoadedSources.length > 0) {
            console.log('[Citation] Re-using pre-loaded research sources...');
            sources = preLoadedSources;
        } else {
            console.log('[Citation] Starting on-the-fly search...');
            const [academicResults, generalResults] = await Promise.all([
                OpenalexAPI.search(context, GKEY, GCX, GROQ, OPENALEX),
                SearxAPI.search(context, 8)
            ]);
            raw = [...academicResults, ...generalResults];
            console.log(`[Citation] Search returned: ${academicResults.length} academic and ${generalResults.length} general results.`);
            
            if (!raw || raw.length === 0) {
                return res.status(200).json({ 
                    success: false, 
                    error: 'No search results. The search service may be temporarily unavailable.',
                    sources: [], text: '', citations: [], stats: null, count: 0
                });
            }
            sources = await ScraperAPI.scrape(raw);
            console.log('[Citation] Scraped:', sources?.length || 0, 'sources');
        }

        // BIBLIOGRAPHY MODE
        if (outputType === 'bibliography') {
            const seen = new Set();
            const uniqueSources = sources.filter(s => {
                const key = s.doi || s.link || s.url;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            
            // Alphabetize Bibliography Mode sources by author family name
            sortSourcesAlphabetically(uniqueSources);
            
            const bibs = uniqueSources.map(s => DoiAPI.formatBib(s, style)).join('\n\n');
            return res.status(200).json({ success: true, sources: uniqueSources, text: bibs, citations: uniqueSources, stats: raw?.stats || null, count: uniqueSources.length });
        }

        // CITATION MODE — Passes down the isAgent boolean flag cleanly
        const prompt = buildPrompt(context, sources);
        const response = await GroqAPI.chat([{ role: 'user', content: prompt }], GROQ, true);
        
        let insertions = [];
        try {
            const json = response.match(/\{[\s\S]*\}/)?.[0];
            insertions = json ? JSON.parse(json).insertions || [] : [];
        } catch (e) {
            console.error('[Citation] JSON parse error:', e.message);
        }

        const result = processInsertions(context, insertions, sources, style, outputType, isAgent);

        // Generate matching bibliography HTML/Plain payload for the secondary textbox
        const seen = new Set();
        const uniqueSources = sources.filter(s => {
            const key = s.doi || s.link || s.url;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        sortSourcesAlphabetically(uniqueSources);
        const plainTexts = uniqueSources.map(s => DoiAPI.formatBib(s, style));
        const bibPlain = plainTexts.join('\n\n');
        const bibHtml = `<div class="bibliography-section" style="margin-top:20px;font-family:'Times New Roman',Times,serif;font-size:12pt;line-height:1.5;">
            <h3 style="text-align:center;margin-bottom:20px;">${outputType === 'footnotes' ? 'Footnotes' : 'Bibliography'}</h3>
            ${plainTexts.map(text => `<p style="margin:0 0 12px 36px;text-indent:-36px;padding-left:36px;">${text}</p>`).join('\n')}
        </div>`;

        return res.status(200).json({ 
            success: true, 
            sources, 
            text: result, 
            citations: sources, 
            bibliographyHtml: bibHtml, 
            bibliographyPlain: bibPlain,
            stats: raw?.stats || null, 
            count: sources.length 
        });

    } catch (error) {
        console.error('[Citation] Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}
