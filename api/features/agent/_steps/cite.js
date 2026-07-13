// ==========================================================================
// FILE PATH: api/features/agent/_steps/cite.js
// ==========================================================================

/**
 * api/features/agent/_steps/cite.js
 * Citation Ingestion Step (Direct Handler Delegator)
 * 
 * Table of Contents:
 * 1. Citation Step Executor Module
 */

import citationHandler from '../../citation.js';
import { buildEssayHTML, buildBibliographyHTML } from '../agentHelpers.js';

// ==========================================================================
// MODULE 1: Citation Step Executor
// ==========================================================================
export async function runCite({
    task,
    previousOutput,
    researchSources = [],
    citationStyle = 'apa7',
    citationType = 'in-text',
    enableQuotes = false,
    preWarmedDigest = null
}, GEMINI, GROQ, budget) {
    const text = previousOutput || '';
    if (!text) return { text: '', citedSources: [] };

    const type = (citationType || 'in-text').toLowerCase().trim();
    const isBibliographyOnly = type === 'bibliography';

    // OPTIMIZATION: If Bibliography Only, do not run any inline semantic parsing/LLM matching.
    // Simply format the bibliography alphabetically and return the untouched essay text.
    if (isBibliographyOnly) {
        const bib = buildBibliographyHTML(researchSources, citationStyle, 'bibliography');
        return {
            text: text, // Keep original essay text fully intact!
            outputHtml: buildEssayHTML(text),
            citedSources: researchSources,
            bibliographyHtml: bib.html,
            bibliographyPlain: bib.plain,
            sourceDigest: preWarmedDigest || {}
        };
    }

    budget.spend('cite');

    // Mock direct API payload for central citation router
    const mockReq = {
        method: 'POST',
        body: {
            context: text,
            style: citationStyle,
            outputType: type,
            apiKey: GROQ,
            googleKey: null,
            preLoadedSources: researchSources,
            isAgent: true // Added flag to let citation handler bypass appended footer
        }
    };

    let citationResult = null;
    const mockRes = {
        setHeader: () => {},
        status: () => ({
            end: () => {},
            json: (data) => { citationResult = data; }
        })
    };

    // Execute central handler directly
    await citationHandler(mockReq, mockRes);

    if (!citationResult || !citationResult.success) {
        console.error('[Cite Step] Citation run failed or returned unsuccessful status.');
        return {
            text: text,
            outputHtml: buildEssayHTML(text),
            citedSources: researchSources,
            bibliographyHtml: '',
            bibliographyPlain: ''
        };
    }

    return {
        text: citationResult.text,
        outputHtml: buildEssayHTML(citationResult.text),
        citedSources: citationResult.sources || researchSources,
        bibliographyHtml: citationResult.bibliographyHtml || '',
        bibliographyPlain: citationResult.bibliographyPlain || '',
        sourceDigest: preWarmedDigest || {}
    };
}