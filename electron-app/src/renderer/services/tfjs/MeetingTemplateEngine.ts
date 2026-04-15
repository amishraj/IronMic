/**
 * MeetingTemplateEngine — Generates structured meeting notes using templates.
 *
 * Takes a meeting template (with LLM prompt and section definitions),
 * substitutes the transcript, calls the LLM, and returns structured output.
 */

export interface MeetingTemplate {
  id: string;
  name: string;
  meeting_type: string;
  sections: string; // JSON array of section keys
  llm_prompt: string; // Contains {transcript} placeholder
  display_layout: string; // JSON with ordering config
  is_builtin: boolean;
}

export interface StructuredSection {
  key: string;
  title: string;
  content: string;
}

export interface StructuredMeetingOutput {
  templateId: string;
  templateName: string;
  sections: StructuredSection[];
  rawOutput: string;
}

/** Human-readable section titles */
const SECTION_TITLES: Record<string, string> = {
  completed: 'Completed',
  in_progress: 'In Progress',
  blockers: 'Blockers',
  discussion_points: 'Discussion Points',
  action_items: 'Action Items',
  feedback: 'Feedback',
  pain_points: 'Pain Points',
  requirements: 'Requirements',
  next_steps: 'Next Steps',
  budget_timeline: 'Budget & Timeline',
  updates: 'Updates',
  decisions: 'Decisions',
  open_questions: 'Open Questions',
  went_well: 'Went Well',
  improve: 'Needs Improvement',
};

/**
 * Generate structured meeting notes from a template and transcript.
 */
export async function generateStructuredNotes(
  template: MeetingTemplate,
  transcript: string,
): Promise<StructuredMeetingOutput> {
  // Substitute transcript into the template's LLM prompt
  const prompt = template.llm_prompt.replace(/\{transcript\}/g, transcript);

  // Call the LLM via the existing polishText IPC
  const ironmic = window.ironmic;
  let rawOutput: string;

  if (ironmic?.polishText && transcript.length > 20) {
    rawOutput = await ironmic.polishText(prompt);
  } else {
    // No LLM available — return the raw transcript organized by template
    rawOutput = transcript;
  }

  // Parse the LLM output into sections based on ## headings
  const sectionKeys: string[] = JSON.parse(template.sections);
  const sections = parseSections(rawOutput, sectionKeys);

  return {
    templateId: template.id,
    templateName: template.name,
    sections,
    rawOutput,
  };
}

/**
 * Parse LLM output into structured sections by matching ## headings
 * to expected section keys.
 */
function parseSections(output: string, sectionKeys: string[]): StructuredSection[] {
  const sections: StructuredSection[] = [];

  // Split by ## headings
  const lines = output.split('\n');
  let currentKey: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      // Save previous section if any
      if (currentKey) {
        sections.push({
          key: currentKey,
          title: SECTION_TITLES[currentKey] || currentKey,
          content: currentContent.join('\n').trim(),
        });
      }

      // Match heading to a section key
      const headingText = headingMatch[1].trim().toLowerCase();
      currentKey = matchSectionKey(headingText, sectionKeys);
      currentContent = [];
    } else if (currentKey) {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentKey) {
    sections.push({
      key: currentKey,
      title: SECTION_TITLES[currentKey] || currentKey,
      content: currentContent.join('\n').trim(),
    });
  }

  // Fill in any missing sections
  for (const key of sectionKeys) {
    if (!sections.find(s => s.key === key)) {
      sections.push({
        key,
        title: SECTION_TITLES[key] || key,
        content: 'None mentioned',
      });
    }
  }

  // Sort by template order
  sections.sort((a, b) => sectionKeys.indexOf(a.key) - sectionKeys.indexOf(b.key));

  return sections;
}

/**
 * Fuzzy-match a heading from LLM output to a section key.
 */
function matchSectionKey(heading: string, sectionKeys: string[]): string | null {
  // Exact match against titles
  for (const key of sectionKeys) {
    const title = (SECTION_TITLES[key] || key).toLowerCase();
    if (heading === title || heading.includes(title) || title.includes(heading)) {
      return key;
    }
  }

  // Fuzzy match against key names (with underscores → spaces)
  for (const key of sectionKeys) {
    const keySpaced = key.replace(/_/g, ' ');
    if (heading.includes(keySpaced) || keySpaced.includes(heading)) {
      return key;
    }
  }

  return sectionKeys[0] || null; // fallback to first section
}

/**
 * Convert structured output to a markdown string for storage.
 */
export function structuredToMarkdown(output: StructuredMeetingOutput): string {
  return output.sections
    .map(s => `## ${s.title}\n\n${s.content}`)
    .join('\n\n');
}
