// api/features/grader.js
import { GeminiAPI } from '../_utils/geminiAPI.js';

// ==========================================================================
// RUBRIC PARSER - Extracts criteria from various rubric formats
// ==========================================================================
const RubricParser = {
    parse(rubricText) {
        if (!rubricText || rubricText.trim().length < 10) {
            return null;
        }

        const criteria = [];
        const lines = rubricText.split('\n').filter(l => l.trim());

        for (const line of lines) {
            const pointsMatch = line.match(/^(.+?)[\s:]+(\d+)\s*(?:points?|pts?|marks?)?/i);
            if (pointsMatch) {
                criteria.push({
                    name: pointsMatch[1].trim(),
                    points: parseInt(pointsMatch[2]),
                    description: line
                });
                continue;
            }

            const bulletMatch = line.match(/^[\-•\*]\s*(.+)/);
            if (bulletMatch) {
                criteria.push({
                    name: bulletMatch[1].trim(),
                    points: null,
                    description: bulletMatch[1].trim()
                });
                continue;
            }

            const numberedMatch = line.match(/^(?:\d+|[A-Za-z])[\.\)]\s*(.+)/);
            if (numberedMatch) {
                criteria.push({
                    name: numberedMatch[1].trim(),
                    points: null,
                    description: numberedMatch[1].trim()
                });
            }
        }

        return criteria.length > 0 ? criteria : null;
    },

    formatForPrompt(criteria) {
        if (!criteria || criteria.length === 0) return null;

        let formatted = "RUBRIC CRITERIA (Grade EACH criterion):\n";
        criteria.forEach((c, i) => {
            if (c.points) {
                formatted += `${i + 1}. ${c.name} (${c.points} points)\n`;
            } else {
                formatted += `${i + 1}. ${c.name}\n`;
            }
        });
        return formatted;
    }
};

// ==========================================================================
// MATERIAL ANALYZER
// ==========================================================================
const MaterialAnalyzer = {
    analyze(instructions, rubric) {
        const analysis = {
            hasRubric: !!(rubric && rubric.trim().length > 10),
            hasInstructions: !!(instructions && instructions.trim().length > 10),
            assignmentType: 'general',
            keyRequirements: []
        };

        const text = `${instructions || ''} ${rubric || ''}`.toLowerCase();

        if (text.includes('essay') || text.includes('argument') || text.includes('thesis')) {
            analysis.assignmentType = 'essay';
            analysis.keyRequirements.push('clear thesis statement', 'supporting arguments', 'evidence', 'conclusion');
        } else if (text.includes('research') || text.includes('sources') || text.includes('citation')) {
            analysis.assignmentType = 'research';
            analysis.keyRequirements.push('research quality', 'source integration', 'citations', 'analysis');
        } else if (text.includes('report') || text.includes('analysis')) {
            analysis.assignmentType = 'report';
            analysis.keyRequirements.push('clarity', 'organization', 'data presentation', 'conclusions');
        } else if (text.includes('creative') || text.includes('story') || text.includes('narrative')) {
            analysis.assignmentType = 'creative';
            analysis.keyRequirements.push('creativity', 'voice', 'narrative structure', 'engagement');
        } else if (text.includes('code') || text.includes('program') || text.includes('function')) {
            analysis.assignmentType = 'code';
            analysis.keyRequirements.push('functionality', 'code quality', 'documentation', 'efficiency');
        }

        return analysis;
    }
};

// ==========================================================================
// PROMPT BUILDER
// ==========================================================================
function buildGradingPrompt(studentText, instructions, rubric, analysis, parsedCriteria) {
    const parts = [];

    parts.push(`ROLE: You are an experienced, fair, and constructive academic grader.
Your goal is to help students IMPROVE. Be specific, actionable, and encouraging.

GRADING PHILOSOPHY:
- Be strict but fair
- Every critique must include HOW to fix it
- Highlight what works well (students need encouragement)
- Reference SPECIFIC parts of the student's work
- If a rubric is provided, grade EACH criterion explicitly`);

    if (analysis.assignmentType !== 'general') {
        parts.push(`\nASSIGNMENT TYPE: ${analysis.assignmentType.toUpperCase()}
Key areas to evaluate: ${analysis.keyRequirements.join(', ')}`);
    }

    if (instructions && instructions.trim()) {
        parts.push(`\n═══════════════════════════════════════════════════════════════
ASSIGNMENT INSTRUCTIONS (What the student was asked to do):
═══════════════════════════════════════════════════════════════
${instructions.trim()}`);
    }

    if (parsedCriteria) {
        parts.push(`\n═══════════════════════════════════════════════════════════════
GRADING RUBRIC (You MUST grade each criterion):
═══════════════════════════════════════════════════════════════
${RubricParser.formatForPrompt(parsedCriteria)}`);
    } else if (rubric && rubric.trim()) {
        parts.push(`\n═══════════════════════════════════════════════════════════════
GRADING CRITERIA:
═══════════════════════════════════════════════════════════════
${rubric.trim()}`);
    }

    parts.push(`\n═══════════════════════════════════════════════════════════════
STUDENT SUBMISSION:
═══════════════════════════════════════════════════════════════
${studentText}`);

    let outputFormat = `\n═══════════════════════════════════════════════════════════════
OUTPUT FORMAT (Follow this structure exactly):
═══════════════════════════════════════════════════════════════

## 📊 Overall Grade: [Letter Grade]
[1-2 sentence summary of overall performance]

`;

    if (parsedCriteria && parsedCriteria.length > 0) {
        outputFormat += `## 📋 Rubric Breakdown\n`;
        parsedCriteria.forEach((c, i) => {
            if (c.points) {
                outputFormat += `### ${c.name} (___/${c.points} points)\n- Score justification\n- Specific evidence from submission\n\n`;
            } else {
                outputFormat += `### ${c.name}\n- Assessment\n- Specific evidence from submission\n\n`;
            }
        });
    }

    outputFormat += `## ✅ Strengths
- [Specific strength with quote/example from text]
- [Another strength]
- [What the student did well]

## ⚠️ Areas for Improvement
- [Specific issue]: "[Quote from text]" → [How to fix it]
- [Another issue]: [Specific example] → [Actionable improvement]
- [Pattern or recurring problem] → [Strategy to address it]

## 🎯 Priority Improvements (Top 3)
1. **[Most important fix]**: [Exactly what to do and why it matters]
2. **[Second priority]**: [Specific steps to improve]
3. **[Third priority]**: [Actionable advice]

## 💡 Next Steps
[2-3 sentences of encouragement and specific next actions the student should take]`;

    parts.push(outputFormat);

    parts.push(`\n═══════════════════════════════════════════════════════════════
CRITICAL GRADING RULES:
═══════════════════════════════════════════════════════════════
1. If a RUBRIC is provided, you MUST score each criterion
2. Every criticism MUST include a specific fix
3. Quote the student's actual text when pointing out issues
4. Be encouraging - help them improve, don't just criticize
5. The "Priority Improvements" section is the MOST IMPORTANT - make it actionable
6. Grade based ONLY on the provided instructions/rubric, not your own expectations`);

    return parts.join('\n');
}

// ==========================================================================
// FOLLOW-UP PROMPT BUILDER
// ==========================================================================
function buildFollowupPrompt(question, context) {
    return `SYSTEM: You are an expert academic grader having a follow-up conversation with a student about their graded work.

CONTEXT:
- You already graded their submission
- Be helpful, specific, and encouraging
- Reference the original feedback when relevant
- Keep responses concise but thorough

ORIGINAL STUDENT SUBMISSION:
${context.studentText.substring(0, 5000)}

${context.instructions ? `ASSIGNMENT INSTRUCTIONS:\n${context.instructions.substring(0, 1000)}\n` : ''}

YOUR PREVIOUS FEEDBACK:
${context.feedback.substring(0, 3000)}

CONVERSATION HISTORY:
${context.chatHistory.slice(-6).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')}

STUDENT'S QUESTION: ${question}

Respond to the student's question naturally and helpfully. Be specific and reference their work when applicable.`;
}

// ==========================================================================
// MAIN HANDLER
// ==========================================================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { 
            text, 
            instructions, 
            rubric,
            files,  
            apiKey,
            action,
            question,
            context 
        } = req.body;
        
        const GEMINI_KEY = apiKey || process.env.GEMINI_API_KEY;

        // ==========================================================
        // OPTIMIZED FOLLOW-UP ACTION
        // ==========================================================
        if (action === 'followup') {
            if (!question || question.trim().length < 1) {
                throw new Error("Please enter a question.");
            }
            if (!context || !context.feedback) {
                throw new Error("Missing grading context. Please grade a document first.");
            }
        
            const prompt = buildFollowupPrompt(question.trim(), context);
            
            // OPTIMIZATION: Bypass heavy multimodal files (PDFs/Images) on follow-up chat turns.
            // Only append lightweight plain-text file attachments if they exist in the context.
            let followUpFileContent = '';
            if (context.files && Array.isArray(context.files)) {
                for (const file of context.files) {
                    if (!file.isBase64 && file.content) {
                        if (!followUpFileContent) {
                            followUpFileContent = '\n\n═══════════════════════════════════════════════════════════════\nATTACHED TEXT FILES:\n═══════════════════════════════════════════════════════════════\n';
                        }
                        followUpFileContent += `\n--- ${file.name} ---\n${file.content.substring(0, 5000)}\n`;
                    }
                }
            }
        
            const finalPrompt = prompt + followUpFileContent;
        
            // Execute standard lightweight text chat to drop visual PDF overhead (saves ~75,000+ tokens per turn)
            const response = await GeminiAPI.chat(finalPrompt, GEMINI_KEY);
        
            return res.status(200).json({
                success: true,
                result: response,
                action: 'followup'
            });
        }

        // ==========================================================
        // GRADING ACTION (default)
        // ==========================================================
        if (!text) throw new Error("No student text provided.");
        if (text.length < 10) throw new Error("Student submission too short (minimum 10 characters).");

        // Parse multimodal binary files (Images & PDFs) alongside text files
        const multimodalFiles = [];
        let fileContent = '';
        if (files && Array.isArray(files) && files.length > 0) {
            for (const file of files) {
                const base64 = file.content && file.content.includes(',') ? file.content.split(',')[1] : file.content;
                const isPDF = file.type === 'application/pdf' || file.name?.toLowerCase().endsWith('.pdf');
                const isImage = file.type?.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name);

                if ((isImage || isPDF) && base64) {
                    const mimeType = isPDF ? 'application/pdf' : (file.type || 'image/jpeg');
                    multimodalFiles.push({ type: mimeType, data: base64 });
                } else if (!file.isBase64 && file.content) {
                    if (!fileContent) fileContent = '\n\n═══════════════════════════════════════════════════════════════\nATTACHED FILES:\n═══════════════════════════════════════════════════════════════\n';
                    fileContent += `\n--- ${file.name} ---\n${file.content.substring(0, 10000)}\n`;
                }
            }
        }

        const safeText = text.substring(0, 30000);
        const safeInstructions = ((instructions || "") + fileContent).substring(0, 5000);
        const safeRubric = (rubric || "").substring(0, 3000);

        const analysis = MaterialAnalyzer.analyze(safeInstructions, safeRubric);
        const parsedCriteria = RubricParser.parse(safeRubric);

        const prompt = buildGradingPrompt(
            safeText,
            safeInstructions,
            safeRubric,
            analysis,
            parsedCriteria
        );

        const feedback = multimodalFiles.length > 0
            ? await GeminiAPI.vision(prompt, GEMINI_KEY, multimodalFiles)
            : await GeminiAPI.chat(prompt, GEMINI_KEY);

        return res.status(200).json({ 
            success: true, 
            result: feedback,
            action: 'grade',
            meta: {
                assignmentType: analysis.assignmentType,
                hasRubric: analysis.hasRubric,
                criteriaCount: parsedCriteria ? parsedCriteria.length : 0,
                filesProcessed: files ? files.length : 0
            }
        });

    } catch (error) {
        console.error("Grader Error:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
}
