// ==========================================================================
// FILE PATH: api/features/agent/_steps/research.js
// ==========================================================================

/**
 * api/features/agent/_steps/research.js
 * Academic Research Step (Powered by OpenAlex & DoiAPI)
 * 
 * Table of Contents:
 * 1. Research Step Executor Module
 */

import { OpenalexAPI } from '../../../_utils/openalex.js';
import { DoiAPI } from '../../../_utils/doiAPI.js';

// ==========================================================================
// MODULE 1: Research Step Executor
// ==========================================================================
export async function runResearch({ topic, citationStyle = 'apa7' }, GROQ, budget) {
    console.log('[Research] Searching for topic:', topic, 'Style:', citationStyle);
    const openAlexKey = process.env.OPENALEX_API_KEY;

    budget.spend('research-search');
    const papers = await OpenalexAPI.search(topic, null, null, GROQ, openAlexKey);
    if (!papers?.length) return { sources: [] };

    // Resolve direct metadata and format academic citations via DoiAPI
    const sources = await Promise.all(papers.slice(0, 12).map(async (p, idx) => {
        const doi = DoiAPI.extractDOI(p.link);
        
        let enriched = {
            id: idx + 1,
            title: p.title,
            url: p.link,
            doi: doi,
            venue: p.venue,
            author: p.authors || 'Unknown',
            authors: [],
            year: p.year,
            displayName: p.authors || 'Unknown',
            text: p.snippet || '',
            citationSource: 'generated'
        };

        if (doi) {
            const meta = await DoiAPI.fetchFromCrossref(doi);
            if (meta) {
                enriched.authors = meta.authors || [];
                enriched.title = meta.title || p.title;
                enriched.venue = meta.journal || p.venue;
                enriched.year = (meta.year && meta.year !== 'n.d.') ? meta.year : p.year;
                enriched.volume = meta.volume || null;
                enriched.issue = meta.issue || null;
                enriched.pages = meta.pages || null;
                enriched.citationSource = 'crossref';
                
                if (meta.authors?.length) {
                    enriched.author = meta.authors.length > 2 
                        ? `${meta.authors[0].family} et al.` 
                        : meta.authors.map(a => a.family).join(' & ');
                    enriched.displayName = enriched.author;
                }
            }
        }

        // Format central bibliography string using DoiAPI formatting engine
        enriched.citation = DoiAPI.formatBib(enriched, citationStyle);
        return enriched;
    }));

    return { sources };
}