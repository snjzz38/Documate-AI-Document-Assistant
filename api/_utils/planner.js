// api/_utils/planner.js
//
// Replaces detectTaskFormat() + getFormatInstructions() entirely. Instead
// of guessing which rigid category a task belongs to (table/essay/steps/
// questions/list/paragraph) and pulling a matching hardcoded template, this
// reads the ACTUAL task once and asks an LLM to produce a concrete writing
// brief: what sections/content this specific deliverable needs, what
// concrete specifics must be included (a named city, real data points, a
// timeline — whatever the task actually calls for), and how long it should
// be. write.js then just follows that brief directly.
//
// This fixes the deeper problem format-guessing couldn't: a category label
// like "essay" doesn't tell the writer it needs to invent a specific city,
// give it real (illustrative) local data, or include a 3-year timeline.
// Reading the task and saying so, in plain instructions, does.
import { GroqAPI } from './groqAPI.js';

const DEFAULT_PLAN = {
    summary: 'Complete the task as directly and completely as the instructions require.',
    instructions: [
        'Read the task and identify every distinct requirement, deliverable, and section it asks for.',
        'Address each requirement explicitly — do not skip optional-sounding details.',
        'Match the format implied by the task (e.g. write prose if it asks for an essay/brief/report; answer directly if it asks short questions).',
        'If the task requires a concrete example, case, or subject that the user hasn\'t provided (e.g. "choose a city", "pick a company"), invent one reasonable, named, realistic example and use it consistently throughout — do not stay generic or hypothetical.'
    ],
    estimatedLength: 'as appropriate to the task'
};

/**
 * Produces a concrete writing brief for the given task via a single Groq
 * call. Falls back to a generic-but-safe default brief on any failure so
 * write.js never blocks on this — worst case it gets generic instructions
 * instead of tailored ones.
 *
 * Returns: { summary, instructions: string[], estimatedLength }
 */
export async function planTask(task, GROQ, budget) {
    if (!task || task.trim().length < 10) {
        return DEFAULT_PLAN;
    }

    if (!GROQ || !budget.spend('plan-task')) {
        return DEFAULT_PLAN;
    }

    const prompt = `Read this task/assignment description carefully and produce a concrete writing brief for whoever will write the response.

TASK:
${task.substring(0, 4000)}

Your job: figure out exactly what the FINAL DELIVERABLE needs to contain and look like — don't describe the assignment back, identify what's actually required to satisfy it.

Pay special attention to:
- Required sections/headers the deliverable must have (if any) — list them in the exact order requested
- Any concrete specifics the task implies but doesn't supply (e.g. "choose a city", "pick a company", "select a case study") — if so, say the writer must invent ONE specific, named, realistic example and use it consistently, rather than staying generic
- Required elements like data points, a timeline, stakeholders, a funding mechanism, a rubric criterion — anything the grading/evaluation would check for
- Tone and audience (e.g. "persuasive, written for a city council" vs "formal academic")
- Approximate length if specified

Distinguish: a numbered/bulleted task description is often just the ASSIGNMENT'S OWN organization (overview, objectives, rubric, submission instructions) — not necessarily the deliverable's structure. Figure out what the deliverable itself needs, which may differ from how the prompt itself is organized.

Return ONLY valid JSON in this exact shape, nothing else:
{
  "summary": "one sentence describing what the deliverable fundamentally is",
  "instructions": ["specific instruction 1", "specific instruction 2", "..."],
  "estimatedLength": "short description like '4-6 pages' or '2-3 paragraphs' or 'as appropriate'"
}

Make "instructions" a list of concrete, actionable directives — not vague advice. Include 4-10 instructions covering structure, required specifics, tone, and anything the task explicitly demands.

Return ONLY the JSON object:`;

    try {
        const raw = await GroqAPI.chat(
            [{ role: 'user', content: prompt }],
            GROQ,
            true
        );
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn('[Planner] No JSON found in response, using default plan');
            return DEFAULT_PLAN;
        }

        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.instructions || !Array.isArray(parsed.instructions) || parsed.instructions.length === 0) {
            console.warn('[Planner] Malformed plan, using default');
            return DEFAULT_PLAN;
        }

        return {
            summary: parsed.summary || DEFAULT_PLAN.summary,
            instructions: parsed.instructions,
            estimatedLength: parsed.estimatedLength || DEFAULT_PLAN.estimatedLength
        };
    } catch (e) {
        console.warn('[Planner] Planning call failed, using default plan:', e.message);
        return DEFAULT_PLAN;
    }
}

/**
 * Formats a plan object into the prompt block write.js injects into its
 * generation prompt.
 */
export function formatPlanForPrompt(plan) {
    const instructionLines = plan.instructions.map(i => `- ${i}`).join('\n');
    return `WRITING BRIEF — what this deliverable needs to be:
${plan.summary}

REQUIREMENTS:
${instructionLines}

LENGTH: ${plan.estimatedLength}`;
}
