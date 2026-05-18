/**
 * MeetingTemplateEngine — Generates structured meeting notes using templates.
 *
 * Takes a meeting template (with LLM prompt and section definitions),
 * substitutes the transcript, calls the LLM, and returns structured output.
 */

import { generateTextWithFallbackToast } from '../ai/generateTextHelper';

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
  /** Sanitized HTML from the markdown pipeline. Populated in 'rich' mode
   *  via convertMarkdown; absent in plain mode so MeetingNotesPanel falls
   *  through to the section-block UI. */
  htmlContent?: string;
}

/** Human-readable section titles. Keys must cover every section id used by
 *  any seeded template — when a key is missing, parseSections falls back
 *  to the raw lowercase key as the title, which then gets serialized into
 *  the auto-filed notebook entry as `## tldr` instead of `## TL;DR`. */
const SECTION_TITLES: Record<string, string> = {
  // Default (builtin-auto) template keys, v12 layout
  attendees: 'Attendees',
  overview: 'Overview',
  // Legacy v11 key for the same Default template — kept so any persisted
  // structured_output written before the v12 migration still maps to a
  // proper title when re-rendered.
  tldr: 'TL;DR',
  discussion: 'Discussion',
  // Standup
  completed: 'Completed',
  in_progress: 'In Progress',
  blockers: 'Blockers',
  // 1-on-1
  discussion_points: 'Discussion Points',
  action_items: 'Action Items',
  feedback: 'Feedback',
  follow_ups: 'Follow-ups',
  // Discovery
  pain_points: 'Pain Points',
  requirements: 'Requirements',
  next_steps: 'Next Steps',
  budget_timeline: 'Budget & Timeline',
  // Team sync
  updates: 'Updates',
  decisions: 'Decisions',
  open_questions: 'Open Questions',
  // Retro
  went_well: 'Went Well',
  improve: 'Needs Improvement',
  // Planning
  scope: 'Scope',
  milestones: 'Milestones',
  owners: 'Owners',
  risks: 'Risks',
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

  // Call the LLM via the generic generateText IPC. polishText layered the
  // cleanup system prompt on top, which conflicted with the template's own
  // instructions — generateText is the dedicated path for non-polish
  // completions. Pass empty system + full prompt as user; Phase 5 splits
  // out the system/user properly when the new Auto-template prompt lands.
  //
  // Routes through generateTextWithFallbackToast so a transparent
  // Copilot-CLI → local-LLM fallback surfaces a one-time toast (matching
  // the SummaryGenerator.callPolish path).
  const ironmic = window.ironmic;
  let rawOutput: string;

  if (ironmic?.generateText && transcript.length > 20) {
    try {
      const result = await generateTextWithFallbackToast('', prompt, {
        maxTokens: 1024,
        temperature: 0.1,
      });
      rawOutput = result.text;
    } catch {
      // No model available — graceful no-op fallback (matches old polishText
      // behavior where missing cleanup model returned input unchanged).
      rawOutput = transcript;
    }
  } else {
    // No LLM available — return the raw transcript organized by template
    rawOutput = transcript;
  }

  // Parse the LLM output into sections based on ## headings
  const sectionKeys: string[] = JSON.parse(template.sections);
  const sections = parseSections(rawOutput, sectionKeys);

  // Convert the markdown LLM output into rich projections so MeetingNotesPanel's
  // htmlContent path lights up automatically. Plain mode skips this — sections
  // alone preserve today's behavior. We respect polish_format_mode here even
  // for meeting summaries because the same Settings toggle covers both surfaces.
  let htmlContent: string | undefined;
  let formatMode: string | null = null;
  try {
    formatMode = await ironmic?.getSetting?.('polish_format_mode');
  } catch { /* ignore */ }
  if (formatMode !== 'plain' && ironmic?.convertMarkdown && rawOutput.trim()) {
    try {
      const projections = await ironmic.convertMarkdown(rawOutput);
      htmlContent = projections.html || undefined;
    } catch {
      // Pipeline error — fall through; downstream will render section blocks.
    }
  }

  return {
    templateId: template.id,
    templateName: template.name,
    sections,
    rawOutput,
    htmlContent,
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
