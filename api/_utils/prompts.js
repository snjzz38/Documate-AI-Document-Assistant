// api/_utils/prompts.js

// ==========================================================================
// PROMPT TEMPLATES (Modular & Reusable)
// ==========================================================================

const Templates = {
    // ------------------------------------------------------------------
    // CITATION FORMAT RULES
    // ------------------------------------------------------------------
    chicagoInText: `
CHICAGO IN-TEXT FORMAT (NO comma between author and year):
- 1 author: (LastName Year) → (Smith 2020)
- 2 authors: (LastName1 and LastName2 Year) → (West and Allen 2018)
- 3+ authors: (LastName1 et al. Year) → (Howden et al. 2007)
- No date: (LastName n.d.)
- Organization/Website: (Organization Year) → (IPCC 2023), (Greenpeace UK n.d.)

CRITICAL - NEVER USE "Unknown":
- If author is unknown, use SITE_NAME or organization name
- Example: IPCC website → (IPCC 2023) NOT (Unknown 2023)

EVERY citation MUST have a year or "n.d." - NEVER just (Author)`,

    apaInText: `
APA IN-TEXT FORMAT (WITH comma between author and year):
- 1 author: (Author, Year) → (Smith, 2020)
- 2 authors: (Author1 & Author2, Year) → (West & Allen, 2018)
- 3+ authors: (Author1 et al., Year) → (Howden et al., 2007)
- Organization: (Organization, Year) → (IPCC, 2023)

CRITICAL - NEVER USE "Unknown":
- If author is unknown, use SITE_NAME → (IPCC, 2023) NOT (Unknown, 2023)
- EVERY citation MUST include year or n.d.`,

    mlaInText: `
MLA IN-TEXT FORMAT:
- 1 author: (LastName)
- 2 authors: (LastName1 and LastName2)
- 3+ authors: (LastName1 et al.)
- Organization: (Organization Name)

Note: MLA typically omits year in parenthetical citations`,

    // ------------------------------------------------------------------
    // BIBLIOGRAPHY FORMAT RULES
    // ------------------------------------------------------------------
    chicagoBib: `
STYLE: Chicago Manual of Style (17th Edition)
FORMAT: LastName, FirstName. "Article Title." *Website Name*. Month Day, Year. URL.
- 2 authors: LastName1, FirstName1, and FirstName2 LastName2.
- 3+ authors: LastName1, FirstName1, et al.
- If DOI exists: use https://doi.org/DOI instead of URL`,

    apaBib: `
STYLE: APA 7th Edition
FORMAT: Author, A. A. (Year). Title of article. *Site Name*. URL
- 2 authors: Author1, A. A., & Author2, B. B. (Year).
- 3+ authors: List all authors with & before last`,

    mlaBib: `
STYLE: MLA 9th Edition
FORMAT: LastName, FirstName. "Article Title." *Container Title*, Date, URL.
- 2 authors: LastName1, FirstName1, and FirstName2 LastName2.
- 3+ authors: LastName1, FirstName1, et al.`,

    // ------------------------------------------------------------------
    // FOOTNOTE INSTRUCTIONS
    // ------------------------------------------------------------------
    footnoteMode: `
══════════════════════════════════════════════════════════════
FOOTNOTE MODE (CRITICAL):
══════════════════════════════════════════════════════════════
- Each insertion gets a UNIQUE footnote number
- Same source CAN and SHOULD be cited multiple times with different numbers
- Example: Source 1 cited 3 times = footnotes 1, 5, 12 (all pointing to same source)
- This is STANDARD academic practice

FOOTNOTE DISTRIBUTION TARGET:
- Introduction: 2-3 footnotes
- Each body paragraph: 3-5 footnotes  
- Conclusion: 2-3 footnotes
- Reuse your best sources 2-4 times each`,

    inTextMode: `
══════════════════════════════════════════════════════════════
IN-TEXT CITATION RULES:
══════════════════════════════════════════════════════════════
- Same source CAN be cited multiple times in different locations
- Each major claim should have a citation
- Distribute citations evenly across all paragraphs`,

    // ------------------------------------------------------------------
    // WHERE TO CITE
    // ------------------------------------------------------------------
    citationPlacements: `
═══════════════════════════════════════════════════════════════
WHERE TO INSERT CITATIONS:
═══════════════════════════════════════════════════════════════

🔴 HIGH PRIORITY - ALWAYS CITE:
• Statistical claims and specific numbers
• Causal statements ("driven by...", "contributes to...")
• Scientific consensus statements
• Definitions and key terms
• Policy references (Paris Agreement, IPCC, etc.)
• Impact statements (health, economic, environmental)
• Predictions/projections

🟡 MEDIUM PRIORITY:
• Topic introductions
• Scope claims ("one of the most pressing...")
• Process descriptions
• Concluding assertions`,

    // ------------------------------------------------------------------
    // ANCHOR RULES
    // ------------------------------------------------------------------
    anchorRules: `
═══════════════════════════════════════════════════════════════
ANCHOR RULES (CRITICAL):
═══════════════════════════════════════════════════════════════

1. Choose 3-8 word phrases that appear EXACTLY in the text
2. Place anchor at END of the claim being cited
3. Each anchor must be UNIQUE - never use the same anchor twice
4. SPREAD citations throughout the text - don't cluster them
5. Maximum 1 citation per sentence (unless comparing sources)
6. Never cite the same source twice at the same location

BAD EXAMPLE:
- anchor: "knowledge that is" → source 1
- anchor: "knowledge that is" → source 2  ❌ DUPLICATE ANCHOR

GOOD EXAMPLE:
- anchor: "a posteriori knowledge" → source 1
- anchor: "depends entirely on experience" → source 2  ✓ DIFFERENT ANCHORS`,

    // ------------------------------------------------------------------
    // VERBATIM QUOTE RULES
    // ------------------------------------------------------------------
    verbatimRules: `
QUOTE EXTRACTION RULES:

1. **VERBATIM REQUIREMENT** (CRITICAL):
   - Extract text EXACTLY as it appears in TEXT_CONTENT
   - Do NOT paraphrase, rearrange, or modify ANY words
   - Do NOT combine sentences from different parts of the text
   - Copy the exact punctuation, capitalization, and wording

2. **QUOTE LENGTH**: Extract SUBSTANTIAL passages (50-200 words)
   - Target: 2-5 complete sentences per quote
   - Extract consecutive sentences that appear together in the source

3. **CONTINUOUS vs NON-CONTINUOUS QUOTES**:
   
   **If sentences are CONSECUTIVE** (appear together in source):
   > "First sentence here. Second sentence follows immediately."
   
   **If sentences are SEPARATED** (from different parts of source):
   > • "First passage from beginning of article."
   > • "Second passage from middle of article."

4. **WHAT TO EXTRACT**:
   ✓ Statistical data and research findings
   ✓ Expert statements and authoritative claims
   ✓ Explanations of causes, effects, or solutions
   ✓ Policy recommendations or action plans
   ✓ Urgency statements or calls to action`
};

// ==========================================================================
// HELPER FUNCTIONS
// ==========================================================================

const Helpers = {
    /**
     * Get citation format rules based on style
     */
    getInTextFormat(style) {
        const s = (style || "").toLowerCase();
        if (s.includes("chicago")) return Templates.chicagoInText;
        if (s.includes("mla")) return Templates.mlaInText;
        return Templates.apaInText;
    },

    /**
     * Get bibliography format rules based on style
     */
    getBibFormat(style) {
        const s = (style || "").toLowerCase();
        if (s.includes("chicago")) return Templates.chicagoBib;
        if (s.includes("mla")) return Templates.mlaBib;
        return Templates.apaBib;
    },

    /**
     * Get footnote or in-text mode instructions
     */
    getModeInstructions(outputType) {
        return outputType === 'footnotes' ? Templates.footnoteMode : Templates.inTextMode;
    },

    /**
     * Build source context for prompts
     */
    buildSourceContext(sources, detailed = false) {
        const safeSources = Array.isArray(sources) ? sources : [];
        
        return safeSources.map(s => {
            const content = s.content || "";
            const meta = s.meta || {};
            
            // Extract year
            let year = meta.year || "n.d.";
            if (year === "n.d." && meta.published && meta.published !== "n.d.") {
                const yearMatch = meta.published.match(/\b(20\d{2})\b/);
                if (yearMatch) year = yearMatch[1];
            }
            if (year === "n.d.") {
                const contentYear = content.match(/\b(20\d{2})\b/);
                if (contentYear) year = contentYear[1];
            }
            
            // Extract authors - NEVER use "Unknown"
            let authors = [];
            if (meta.allAuthors && meta.allAuthors.length > 0) {
                authors = meta.allAuthors;
            } else if (meta.author && meta.author !== "Unknown") {
                authors = [meta.author];
            }
            
            // Fallback to site name
            const siteName = meta.siteName || s.title.split(/[:\-–|]/).shift().trim() || "Unknown Source";
            const displayAuthors = authors.length > 0 ? authors.join(' | ') : siteName;
            
            // Extract DOI
            let doi = "none";
            const doiMatch = content.match(/doi\.org\/([^\s]+)|DOI:\s*([^\s]+)/i);
            if (doiMatch) {
                doi = (doiMatch[1] || doiMatch[2]).replace(/[.,;]+$/, '');
            }
            
            if (detailed) {
                return `[ID:${s.id}]
TITLE: ${s.title}
FULL_URL: ${s.link}
DOI: ${doi}
SITE_NAME: ${siteName}
ALL_AUTHORS: ${displayAuthors}
USE_FOR_CITATION: ${displayAuthors.split(' | ')[0]} ← Use this name in citations, NEVER "Unknown"
AUTHOR_COUNT: ${authors.length || 1}
YEAR: ${year}
TEXT_CONTENT: ${content.substring(0, 1000).replace(/\n/g, ' ')}...`;
            }
            
            return `[ID:${s.id}] ${s.title}
  FULL_URL: ${s.link}
  AUTHORS: ${displayAuthors} (${authors.length || 1} author(s))
  YEAR: ${year}
  SITE: ${siteName}
  CONTENT PREVIEW: ${content.substring(0, 400).replace(/\n/g, ' ')}...`;
        }).join('\n\n---\n\n');
    },

    /**
     * Calculate citation targets
     */
    getTargets(sources, context) {
        const count = Array.isArray(sources) ? sources.length : 0;
        const sentences = (context.match(/[.!?]+/g) || []).length;
        
        return {
            minSources: Math.max(8, count - 2),
            targetInsertions: Math.max(Math.floor(count * 1.5), 12),
            targetDensity: Math.max(Math.floor(sentences * 0.5), 12)
        };
    },

    /**
     * Get today's date formatted
     */
    getToday() {
        return new Date().toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });
    }
};

// ==========================================================================
// MAIN EXPORT: CitationPrompts
// ==========================================================================

export const CitationPrompts = {

    /**
     * STEP 1: Generate formatted bibliography entries
     */
    buildStep1(style, sources) {
        const today = Helpers.getToday();
        const sourceContext = Helpers.buildSourceContext(sources, true);
        const bibFormat = Helpers.getBibFormat(style);
        
        return `
TASK: Generate formatted bibliography entries for ALL ${sources.length} sources.

${bibFormat}

SOURCES:
${sourceContext}

INSTRUCTIONS:
- Create ONE bibliography entry per source
- Use ALL authors from ALL_AUTHORS (use "et al." for 3+)
- If author is unknown, use SITE_NAME as author
- Include DOI if available (not "none")
- End each entry with: (Accessed ${today})

OUTPUT: Return JSON only:
{
  "1": "Complete formatted citation for source 1",
  "2": "Complete formatted citation for source 2"
}
`;
    },

    /**
     * STEP 2: Generate insertion points
     */
    buildStep2(outputType, style, context, sources, formattedCitations) {
        const sourceContext = Helpers.buildSourceContext(sources, false);
        const citationFormat = Helpers.getInTextFormat(style);
        const modeInstructions = Helpers.getModeInstructions(outputType);
        const targets = Helpers.getTargets(sources, context);
        
        return `
TASK: Determine WHERE to insert citations in the user's text.

${citationFormat}
${modeInstructions}

AVAILABLE SOURCES (${sources.length} total):
${sourceContext}

TEXT TO CITE:
"${context}"

═══════════════════════════════════════════════════════════════
🎯 CITATION TARGETS (MANDATORY):
═══════════════════════════════════════════════════════════════

1. SOURCE COVERAGE: Use AT LEAST ${targets.minSources} out of ${sources.length} sources
   → "Further Reading" should have AT MOST 2 sources
   
2. INSERTION COUNT: Create AT LEAST ${targets.targetDensity} citation insertions
   → More is better - aim for ${targets.targetDensity + 5} if possible
   
3. DISTRIBUTION REQUIREMENTS:
   • Introduction: 2-4 citations
   • Body paragraph 1: 3-5 citations
   • Body paragraph 2: 3-5 citations  
   • Body paragraph 3: 3-5 citations
   • Conclusion: 2-4 citations
   
4. SOURCE REUSE: Cite strongest sources 2-4 times each

${Templates.citationPlacements}

${Templates.anchorRules}

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT (JSON only):
═══════════════════════════════════════════════════════════════

{
  "insertions": [
    { "anchor": "exact phrase from text", "source_id": 1, "citation_text": "(Author Year)" },
    { "anchor": "another phrase", "source_id": 2, "citation_text": "(Author Year)" }
  ]
}

═══════════════════════════════════════════════════════════════
⚠️ PRE-SUBMISSION CHECKLIST:
═══════════════════════════════════════════════════════════════

□ ${targets.minSources}+ different source_ids used?
□ ${targets.targetDensity}+ total insertions?
□ Citations in intro, body, AND conclusion?
□ All anchors are exact phrases from text?
□ All citation_text includes year or "n.d."?
□ NO "Unknown" authors - use site name instead?
□ Output is valid JSON only?

IF ANY IS NO → Add more citations before outputting!
`;
    },

    /**
     * MAIN BUILD: For quotes and bibliography modes
     */
    build(type, style, context, sources) {
        const today = Helpers.getToday();
        const safeSources = Array.isArray(sources) ? sources : [];

        // ==================== QUOTES MODE ====================
        if (type === 'quotes') {
            // Build source context with clear URL emphasis
            const sourceContext = safeSources.map((s, idx) => {
                return `[ID:${s.id}]
TITLE: ${s.title}
FULL_URL: ${s.link}
SITE: ${s.meta?.siteName || new URL(s.link).hostname}
CONTENT: ${(s.content || '').substring(0, 800).replace(/\n/g, ' ')}...`;
            }).join('\n\n---\n\n');
            
            return `
TASK: Extract substantial, meaningful quotes from each source - VERBATIM ONLY.

USER'S TEXT CONTEXT: "${context.substring(0, 500)}..."

SOURCES:
${sourceContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 MANDATORY: Extract quotes from ALL ${safeSources.length} sources
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${Templates.verbatimRules}

OUTPUT FORMAT (strictly in order ID 1 to ${safeSources.length}):

**[ID] Title** - FULL_URL
> "Exact text from source copied verbatim."

EXAMPLE (showing FULL URL):
**[1] David Hume - Stanford Encyclopedia of Philosophy** - https://plato.stanford.edu/entries/hume/
> "Hume recognized two kinds of perception: impressions, which are vivid and forceful, and ideas, which are the less lively copies of impressions."

CRITICAL RULES:
1. Use the COMPLETE URL from FULL_URL field (e.g., https://plato.stanford.edu/entries/hume/)
2. NOT just the domain (e.g., NOT https://plato.stanford.edu)
3. Copy quotes VERBATIM - no paraphrasing
4. Include 2-5 sentences per quote (50-200 words)
5. If no relevant quote, say "No relevant quote found."
`;
        }

        // ==================== BIBLIOGRAPHY MODE ====================
        if (type === 'bibliography') {
            const sourceContext = Helpers.buildSourceContext(safeSources, true);
            const bibFormat = Helpers.getBibFormat(style);
            
            return `
TASK: Generate a bibliography for ALL ${safeSources.length} sources.

${bibFormat}

SOURCES:
${sourceContext}

INSTRUCTIONS:
- Create a properly formatted bibliography entry for EACH source
- Use ALL authors from ALL_AUTHORS field
- If author is "Unknown", use SITE_NAME instead
- Include DOI when available (not "none")
- Sort entries alphabetically by last name
- Output ONLY the bibliography entries, NO explanations

OUTPUT: Return ONLY the formatted bibliography entries, nothing else.
`;
        }

        // ==================== FALLBACK: Combined prompt ====================
        const sourceContext = Helpers.buildSourceContext(safeSources, false);
        const targets = Helpers.getTargets(safeSources, context);
        const citationFormat = Helpers.getInTextFormat(style);

        return `
TASK: Insert ${style || "Chicago"} citations into text.

${citationFormat}

SOURCES (${safeSources.length}):
${sourceContext}

TEXT: "${context}"

TARGETS: Use ${targets.minSources}+ sources, ${targets.targetInsertions}+ insertions

OUTPUT JSON:
{
  "insertions": [
    { "anchor": "phrase from text", "source_id": 1, "citation_text": "(Author Year)" }
  ],
  "formatted_citations": {
    "1": "Full bibliography entry (Accessed ${today})"
  }
}
`;
    }
};

// Export helpers for use in other modules if needed
export { Helpers, Templates };
