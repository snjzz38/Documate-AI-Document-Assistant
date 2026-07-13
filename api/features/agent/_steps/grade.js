// ==========================================================================
// FILE PATH: api/features/agent/_steps/grade.js
// ==========================================================================

/**
 * api/features/agent/_steps/grade.js
 * Academic Grading Step (Grader Delegator)
 * 
 * Table of Contents:
 * 1. Academic Grading Executor Module
 */

import graderHandler from '../../grader.js';
import { buildBibliographyHTML } from '../agentHelpers.js';

// ==========================================================================
// MODULE 1: Academic Grading Executor
// ==========================================================================
export async function runGrade({
    task,
    rubric = '',
    previousOutput,
    researchSources = [],
    citationStyle = 'apa7',
    citationType = 'in-text',
    enableCite = false,
    uploadedFiles = []
}, budget) {
    const text = previousOutput || '';
    if (!text) return { grade: 'N/A', feedback: 'No text to grade.' };

    let fullSubmission = text;
    if (researchSources.length && enableCite) {
        const bib = buildBibliographyHTML(
            researchSources, citationStyle,
            citationType === 'footnotes' ? 'footnotes' : 'bibliography'
        );
        if (bib.plain) fullSubmission = text + '\n\n' + bib.plain;
    }

    budget.spend('grade');
    const mockReq = {
        method: 'POST',
        body: {
            text: fullSubmission,
            instructions: task || '',
            rubric: rubric || '',
            files: uploadedFiles.map(f => ({ name: f.name, type: f.type, content: f.data, isBase64: true }))
        }
    };

    let gradeResult = null;
    const mockRes = { setHeader: () => {}, status: () => ({ end: () => {}, json: d => { gradeResult = d; } }) };
    
    // Execute central handler directly
    await graderHandler(mockReq, mockRes);

    const feedback = gradeResult?.result || 'Grading completed.';
    const gradeMatch = feedback.match(/(?:Overall\s+)?Grade[:\s]*([A-F][+-]?|\d+[\/.]\d+)/i)
        || feedback.match(/([A-F][+-]?)\s*(?:\/|out of|\()/i);

    return { grade: gradeMatch ? gradeMatch[1].toUpperCase() : '—', feedback };
}