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
import { buildEssayHTML } from '../agentHelpers.js';

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

    budget.spend('cite');

    // Mock direct API payload for central citation router
    const mockReq = {
        method: 'POST',
        body: {
            context: text,
            style: citationStyle,
            outputType: citationType,
            apiKey: GROQ,
            googleKey: null,
            preLoadedSources: researchSources
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