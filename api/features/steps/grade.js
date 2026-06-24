// api/features/steps/grade.js
import graderHandler from '../grader.js';
import { buildBibliographyHTML } from '../../utils/htmlBuilders.js';

/**
 * Grades the final text submission, attaching a plaintext bibliography
 * to the grader's input when citations were enabled.
 */
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
    await graderHandler(mockReq, mockRes);

    const feedback = gradeResult?.result || 'Grading completed.';
    const gradeMatch = feedback.match(/(?:Overall\s+)?Grade[:\s]*([A-F][+-]?|\d+[\/.]\d+)/i)
        || feedback.match(/([A-F][+-]?)\s*(?:\/|out of|\()/i);

    return { grade: gradeMatch ? gradeMatch[1].toUpperCase() : '—', feedback };
}
