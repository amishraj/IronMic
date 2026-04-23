import { FileText } from 'lucide-react';
import type { StructuredMeetingOutput, StructuredSection } from '../services/tfjs/MeetingTemplateEngine';

interface Props {
  structuredOutput: StructuredMeetingOutput | null;
  summary: string | null;
  /** Formatted HTML synced from the Notes page (TipTap output). When present,
   *  rendered instead of plain text so user formatting is preserved. */
  htmlContent?: string | null;
  isGenerating: boolean;
}

function SkeletonLine({ width = 'full' }: { width?: string }) {
  return (
    <div className={`h-3 bg-gray-200 rounded animate-pulse w-${width}`} />
  );
}

function SectionBlock({ section }: { section: StructuredSection }) {
  if (!section.content || section.content.trim() === 'None mentioned') return null;

  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        {section.title}
      </h4>
      <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
        {section.content}
      </div>
    </div>
  );
}

export function MeetingNotesPanel({ structuredOutput, summary, htmlContent, isGenerating }: Props) {
  // Generating skeleton
  if (isGenerating && !structuredOutput && !summary && !htmlContent) {
    return (
      <div className="space-y-5 animate-pulse">
        <div className="space-y-2">
          <SkeletonLine width="1/3" />
          <SkeletonLine />
          <SkeletonLine width="4/5" />
          <SkeletonLine width="3/4" />
        </div>
        <div className="space-y-2">
          <SkeletonLine width="1/4" />
          <SkeletonLine />
          <SkeletonLine width="5/6" />
        </div>
        <div className="space-y-2">
          <SkeletonLine width="1/3" />
          <SkeletonLine width="2/3" />
          <SkeletonLine width="1/2" />
        </div>
      </div>
    );
  }

  // User-formatted HTML from Notes page — highest priority. Renders TipTap HTML
  // so bold, headings, bullet lists, etc. are preserved exactly as the user set them.
  if (htmlContent) {
    return (
      <div className="space-y-3">
        {isGenerating && (
          <p className="text-xs text-gray-400 italic">Updating notes…</p>
        )}
        <div
          className="prose prose-invert prose-sm max-w-none text-iron-text leading-relaxed"
          // htmlContent originates from TipTap on the same machine — safe to render.
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      </div>
    );
  }

  // Structured template output
  if (structuredOutput?.sections && structuredOutput.sections.length > 0) {
    const visibleSections = structuredOutput.sections.filter(
      s => s.content && s.content.trim() !== 'None mentioned'
    );

    return (
      <div className="space-y-5">
        {isGenerating && (
          <p className="text-xs text-gray-400 italic">Updating notes…</p>
        )}
        {visibleSections.length > 0 ? (
          visibleSections.map(section => (
            <SectionBlock key={section.key} section={section} />
          ))
        ) : (
          <p className="text-sm text-gray-400 italic">Notes will appear here after the meeting ends.</p>
        )}
      </div>
    );
  }

  // Plain summary (generic template or no template)
  if (summary) {
    return (
      <div className="space-y-3">
        {isGenerating && (
          <p className="text-xs text-gray-400 italic">Updating notes…</p>
        )}
        <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
          {summary}
        </div>
      </div>
    );
  }

  // Empty state
  return (
    <div className="flex flex-col items-center justify-center h-full text-center py-12 px-4">
      <FileText className="w-8 h-8 text-gray-300 mb-3" />
      <p className="text-sm text-gray-400">
        AI notes will appear here after the meeting ends.
      </p>
      <p className="text-xs text-gray-300 mt-1">
        Notes are generated using your selected template.
      </p>
    </div>
  );
}
