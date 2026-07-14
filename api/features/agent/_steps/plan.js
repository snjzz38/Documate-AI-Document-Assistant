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
1. "topic": A unified top-level 3-6 word search query for paper retrieval. Do not use punctuation.
2. "scale_profile": Assess the scope. If the task requests >1500 words or >6 sources, tier is "high_horizon". Else "standard".
3. "plan": A detailed writing brief with "sections" (array of targeted section headers) and "writing_tips" (array of 3 specific guidelines to improve writing quality for this task).

CRITICAL FORMAT TRANSLATION RULES:
- If the original task requests an organizing "table" (e.g., arguments for and against), do NOT plan a markdown table. Instead, translate that requirement into beautifully structured prose paragraphs with clear descriptive subheadings or standard numerical listings, as raw markdown tables do not copy-paste cleanly into editors like Google Docs.
- USER-STRUCTURE ALIGNMENT: Read the task carefully. If the user specifies an outline structure (e.g. "Introduction", "Arguments For", "Arguments Against", "Decision", "Justification"), you MUST follow their requested structural sections exactly in "sectored_outlines".
- SOURCE CAP: If the requested sources exceed 20, cap "total_target_sources" at 16 to maintain API safety and context performance.

Return ONLY valid JSON:
{
  "topic": "neurodiversity inclusive education workplaces",
  "scale_profile": {
    "tier": "high_horizon",
    "total_target_words": 3000,
    "total_target_sources": 12,
    "sectored_outlines": [
      {
        "id": 1,
        "heading": "Introduction: The Neurodiversity Paradigm",
        "target_words": 700,
        "search_query": "neurodiversity paradigm history and origins"
      },
      {
        "id": 2,
        "heading": "Arguments for Embracing Cognitive Differences",
        "target_words": 800,
        "search_query": "benefits of neurodiversity in classroom and workplace"
      }
    ]
  },
  "plan": {
    "sections": ["Introduction: The Neurodiversity Paradigm", "Arguments for Embracing Cognitive Differences"],
    "writing_tips": ["Use active, conversational phrasing.", "Explicitly connect evidence to the thesis.", "Avoid passive relative clauses."]
  }
}`;

        const response = await GroqAPI.chat([{ role: 'user', content: prompt }], GROQ, true);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON outline returned');

        const data = JSON.parse(jsonMatch[0]);
        
        // Handle standard fallback if model returned incomplete scale profile
        const scaleProfile = data.scale_profile || {
            tier: 'standard',
            total_target_words: 1000,
            total_target_sources: 4,
            sectored_outlines: (data.plan?.sections || ["Introduction", "Analysis", "Conclusion"]).map((h, i) => ({
                id: i + 1,
                heading: h,
                target_words: 400,
                search_query: data.topic || fallbackTopic
            }))
        };

        return {
            topic: data.topic || fallbackTopic,
            scale_profile: scaleProfile,
            plan: data.plan || { sections: ["Introduction", "Analysis", "Conclusion"], writing_tips: ["Maintain objective academic tone."] }
        };
    } catch (e) {
        console.warn('[Plan Step] Planning failed, utilizing fallback outline:', e.message);
        return {
            topic: fallbackTopic,
            scale_profile: {
                tier: 'standard',
                total_target_words: 1000,
                total_target_sources: 4,
                sectored_outlines: [{ id: 1, heading: "Essay Content", target_words: 1000, search_query: fallbackTopic }]
            },
            plan: { sections: ["Essay Content"], writing_tips: ["Maintain objective academic tone."] }
        };
    }
}