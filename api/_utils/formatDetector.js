// api/_utils/formatDetector.js
//
// Replaces the regex-only detectTaskFormat() heuristic with a Groq call
// that actually reads the task and distinguishes between:
//   - a task whose own numbered/bulleted structure IS the deliverable
//     (e.g. "1. Define X. 2. Compare Y and Z." -> answer each directly)
//   - a task that DESCRIBES an assignment with its own meta-structure
//     (overview, learning objectives, rubric, submission instructions)
//     where the actual deliverable is a single cohesive document (essay,
//     policy brief, report) that should NOT mirror those meta-sections
//
// The regex heuristic in textCleanup.js cannot make this distinction —
// it just pattern-matches on the presence of numbered lines, which both
// cases share. This was causing structured assignments (policy briefs,
// lab reports, etc.) to be misclassified as 'steps', producing output
// that restates the assignment's overview/rubric/submission sections
// instead of writing the actual deliverable.
import { GroqAPI } from './groqAPI.js';
import { detectTaskFormat as detectTaskFormatHeuristic } from './textCleanup.js';

const VALID_FORMATS = new Set([
    'table', 'steps', 'structured', 'questions', 'list', 'paragraph', 'essay', 'general'
]);

/**
 * Classifies the task into the same format categories detectTaskFormat()
 * uses, but with actual reading comprehension instead of regex pattern
 * matching. Falls back to the heuristic on any failure so format
 * detection never breaks outright.
 */
export async function detectTaskFormatSmart(task, GROQ, budget) {
    if (!task || task.trim().length < 10) {
        return detectTaskFormatHeuristic(task || '');
    }

    if (!GROQ || !budget.spend('format-detect')) {
        return detectTaskFormatHeuristic(task);
    }

    const prompt = `Read this task/assignment description and classify what kind of DELIVERABLE the student must produce. Choose exactly ONE category:

- "table": the task explicitly asks for an arguments-for/arguments-against structured comparison with a decision and justification
- "essay": the deliverable is a single cohesive document with flowing prose — an essay, policy brief, report, lab report, research paper, or similar. This applies even if the task description ITSELF has numbered sections (like "1. Overview, 2. Objectives, 3. Required Structure, 4. Rubric") — those numbered sections describe the ASSIGNMENT'S metadata, not the deliverable's structure. If the task mentions things like "Executive Summary", "Problem Statement", "Proposed Interventions", "References", a rubric, point values, submission instructions, or a due date, the deliverable is almost certainly "essay" even though the prompt itself is numbered.
- "steps": the numbered/bulleted items ARE themselves the direct deliverable — e.g. "1. Define photosynthesis. 2. Compare it to respiration. 3. List two examples." Each numbered item is a short thing to directly answer, with no overall document structure expected.
- "questions": a list of direct questions to answer
- "list": asks for a bulleted list/outline as the final output
- "paragraph": asks for a single short paragraph or brief response
- "general": none of the above fit clearly

CRITICAL DISTINGUISHING RULE: if the task has sections like "Assignment Overview", "Learning Objectives", "Grading Rubric", "Submission Instructions", "Due Date", "Weight", or point-value breakdowns — these are ASSIGNMENT METADATA, not deliverable structure. The real deliverable in these cases is almost always "essay" (a cohesive written document), even though the prompt describing it is itself organized into numbered sections.

TASK:
${task.substring(0, 4000)}

Return ONLY the category word, nothing else.`;

    try {
        const result = await GroqAPI.chat(
            [{ role: 'user', content: prompt }],
            GROQ,
            false
        );
        const cleaned = result.trim().toLowerCase().replace(/[^a-z]/g, '');

        if (VALID_FORMATS.has(cleaned)) {
            return cleaned;
        }

        console.warn('[FormatDetector] Unexpected result, falling back to heuristic:', cleaned);
        return detectTaskFormatHeuristic(task);
    } catch (e) {
        console.warn('[FormatDetector] Groq classification failed, falling back to heuristic:', e.message);
        return detectTaskFormatHeuristic(task);
    }
}
