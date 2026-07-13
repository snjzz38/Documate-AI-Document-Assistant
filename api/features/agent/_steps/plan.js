// ==========================================================================
// FILE PATH: api/features/agent/_steps/plan.js
// ==========================================================================

/**
 * api/features/agent/_steps/plan.js
 * Content & Topic Planning Step (Precursor Step)
 * 
 * Table of Contents:
 * 1. Planning Step Executor Module
 */

import { GroqAPI } from '../../../_utils/groqAPI.js';

// ==========================================================================
// MODULE 1: Planning Step Executor
// ==========================================================================
export async function runPlan({ task }, GROQ, budget) {
    console.log('[Plan Step] Running precursor planning...');
    budget.spend('plan-topic-extraction');

    const fallbackTopic = (task || 'general research')
        .toLowerCase()
        .match(/\b[a-z]{4,}\b/g)
        ?.slice(0, 5)
        .join(' ') || 'general research';

    try {
        const prompt = `You are an academic curriculum director and research planner. Analyze this student task.

TASK:
"${task.substring(0, 2000)}"

Return a raw JSON object containing:
1. "topic": A highly optimized, academic 3-6 word search query for paper retrieval. Do not use punctuation.
2. "plan": A detailed writing brief with "sections" (array of targeted section headers) and "writing_tips" (array of 3 specific guidelines to improve writing quality for this task).

Return ONLY valid JSON:
{
  "topic": "neurodiversity inclusive education workplaces",
  "plan": {
    "sections": ["Introduction", "Analysis", "Conclusion"],
    "writing_tips": ["Use active, conversational phrasing.", "Explicitly connect evidence to the thesis.", "Avoid passive relative clauses."]
  }
}`;

        const response = await GroqAPI.chat([{ role: 'user', content: prompt }], GROQ, true);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON outline returned');

        const data = JSON.parse(jsonMatch[0]);
        return {
            topic: data.topic || fallbackTopic,
            plan: data.plan || { sections: ["Introduction", "Analysis", "Conclusion"], writing_tips: [] }
        };
    } catch (e) {
        console.warn('[Plan Step] Planning failed, utilizing fallback outline:', e.message);
        return {
            topic: fallbackTopic,
            plan: { sections: ["Introduction", "Analysis", "Conclusion"], writing_tips: ["Maintain objective academic tone."] }
        };
    }
}