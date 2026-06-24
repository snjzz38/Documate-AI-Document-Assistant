// api/_utils/formatInstructions.js

export const getFormatInstructions = fmt => {
    switch (fmt) {

        case 'table':
            return `FORMAT — STRUCTURED TABLE ASSIGNMENT. Output EXACTLY these four sections with their headers on their own lines.

ARGUMENTS FOR (EMBRACE):
- [Argument 1: EXACTLY 2-3 sentences. S1: state the specific claim. S2: explain the mechanism or consequence — WHY does this matter? S3 (optional): concrete real-world example.]
- [Argument 2: different angle, same structure]
- [Argument 3: different angle, same structure]
- [Argument 4: different angle, same structure]

ARGUMENTS AGAINST (PANIC):
- [Argument 1: same structure as above]
- [Argument 2: different angle]
- [Argument 3: different angle]
- [Argument 4: different angle]

DECISION:
Exactly ONE sentence. State your position and the single most decisive reason. No quotes. No restatement.

JUSTIFICATION:
Exactly 4 paragraphs. Each paragraph covers a DISTINCT dimension (e.g. biological, economic, ethical, ecological — do not repeat the same dimension).

Each paragraph structure:
  S1: Specific claim relevant to your decision.
  S2–S3: Mechanism — WHY does this matter? What specific consequence does it lead to? Name it concretely.
  S4: Engage the strongest counterargument to this point in one sentence (e.g. "Proponents argue that regulation could prevent this..."), then refute it in S5 with a specific reason it falls short.

SOURCE DIVERSITY RULE — STRICTLY ENFORCED:
- Do NOT cite the same source in more than 2 consecutive sentences.
- Each paragraph must draw on at least 2 different ideas (they don't need to be from different sources, but the ideas must be distinct).
- If you find yourself citing the same author repeatedly in a row, switch to a different angle or piece of evidence first.

"SO WHAT?" RULE — STRICTLY ENFORCED:
After every claim, the next sentence must name a SPECIFIC consequence.
BAD: "This highlights the importance of caution."
GOOD: "A single off-target mutation in the embryo propagates into every cell of every descendant, making reversal biologically impossible."

SPECIFICITY RULE:
When claiming a risk or benefit, include at least one concrete anchor:
- A named condition, disease, or biological process (e.g. sickle cell anemia, off-target indels)
- A real-world precedent or analogy (e.g. thalidomide, monoculture crop failures)
- A measurable or observable outcome (e.g. "increases edit precision to 99% but still leaves a 1% error rate across billions of base pairs")

SENTENCE STARTER RULES:
- NEVER start any sentence or bullet with "Because"
- NEVER start two consecutive sentences with the same word

FILLER RULE:
These sentence patterns are FORBIDDEN — delete them if you write them:
- "The potential for X is undeniable"
- "X is not without risk"
- "The prospect of X raises concerns"
- "When researchers gain X, it paves the way for Y" (restating the previous sentence)
- Any sentence that makes a vague observation without naming a specific consequence

CRITICAL: All four headers (ARGUMENTS FOR (EMBRACE):, ARGUMENTS AGAINST (PANIC):, DECISION:, JUSTIFICATION:) MUST appear verbatim on their own lines.`;

        case 'steps':
        case 'structured':
            return `FORMAT — STRUCTURED ASSIGNMENT:
- Read the task carefully and identify each distinct section or deliverable
- Complete each section fully, in the order given
- Use the exact section labels from the task
- Do NOT convert this into a prose essay
- Plain text, no markdown formatting`;

        case 'questions':
            return `FORMAT — ANSWER EACH QUESTION:
- Answer each question directly and completely, keeping original numbering
- Plain text only — no markdown`;

        case 'list':
            return `FORMAT — LIST:
- Clear, organized structure
- Plain text only — no markdown`;

        case 'paragraph':
            return `FORMAT — PARAGRAPH RESPONSE:
- Write a single well-developed paragraph (or the number specified)
- Do NOT expand into a multi-section essay
- Plain text only — no markdown`;

        case 'essay':
            return `FORMAT — ACADEMIC ESSAY:
- Introduction with explicit thesis in final sentence
- Body paragraphs: one main point each; after every claim, name the specific consequence ("So what?")
- At least one paragraph must engage a counterargument and refute it with specific reasoning
- No two paragraphs may cover the same dimension
- Conclusion: synthesize, don't summarize
- Vary sentence openings; formal academic tone throughout`;

        default:
            return `FORMAT — MATCH THE TASK EXACTLY:
- Identify what format the task asks for and produce ONLY that
- NEVER write a multi-section essay unless the task uses the word "essay"
- Do NOT add titles, headers, or sections the task did not ask for
- Plain text — no markdown`;
    }
};
