// api/features/steps/research.js
import { SourceFinderAPI } from '../../_utils/sourceFinder.js';
import { extractTopicSmart } from '../../_utils/topicExtractor.js';

/**
 * Finds and normalizes academic sources for the given task.
 * No dependencies on other steps — always safe to run first / in parallel.
 */
export async function runResearch({ task, citationStyle = 'apa7' }, GROQ, budget) {
    const topic = await extractTopicSmart(task || '', GROQ, budget);
    console.log('[Research] Topic:', topic, 'Style:', citationStyle);
    budget.spend('research-search');

    const papers = await SourceFinderAPI.searchTopic(topic, 12, citationStyle);
    if (!papers?.length) return { sources: [] };

    const sources = papers.map(p => ({
        id: p.id,
        title: p.title,
        url: p.url,
        doi: p.doi,
        venue: p.venue,
        author: p.author,
        authors: p.authors || [],
        year: p.year,
        displayName: p.author || p.displayName,
        text: p.abstract || p.text,
        citation: p.citation || SourceFinderAPI._formatCitation(p, citationStyle),
        citationSource: p.citationSource || 'generated',
        volume: p.volume || null,
        issue: p.issue || null,
        pages: p.pages || null
    }));

    console.log(
        '[Research] Crossref sources:',
        sources.filter(s => s.citationSource === 'crossref').length,
        '/',
        sources.length
    );

    return { sources };
}
