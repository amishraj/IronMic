import { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { Card } from './ui';

const SECTION_OPTIONS = [
  { key: 'completed', label: 'Completed' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'blockers', label: 'Blockers' },
  { key: 'discussion_points', label: 'Discussion Points' },
  { key: 'action_items', label: 'Action Items' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'pain_points', label: 'Pain Points' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'next_steps', label: 'Next Steps' },
  { key: 'budget_timeline', label: 'Budget & Timeline' },
  { key: 'updates', label: 'Updates' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'open_questions', label: 'Open Questions' },
  { key: 'went_well', label: 'Went Well' },
  { key: 'improve', label: 'Needs Improvement' },
];

interface Props {
  onSave: (name: string, meetingType: string, sections: string[], llmPrompt: string) => Promise<void>;
  onCancel: () => void;
}

export function MeetingTemplateEditor({ onSave, onCancel }: Props) {
  const [name, setName] = useState('');
  const [meetingType, setMeetingType] = useState('custom');
  const [selectedSections, setSelectedSections] = useState<string[]>(['action_items']);
  const [saving, setSaving] = useState(false);

  const toggleSection = (key: string) => {
    setSelectedSections(prev =>
      prev.includes(key) ? prev.filter(s => s !== key) : [...prev, key]
    );
  };

  const buildPrompt = () => {
    const sectionText = selectedSections
      .map(key => {
        const label = SECTION_OPTIONS.find(s => s.key === key)?.label || key;
        return `## ${label}\n- ...`;
      })
      .join('\n\n');

    return `You are a meeting notes assistant. Given the following meeting transcript, extract structured notes.\n\nRules:\n- Extract relevant information into each section below\n- Use bullet points for each item\n- Keep items concise but actionable\n- If a section has no items, write "None mentioned"\n- Output ONLY the structured sections, no preamble\n\nFormat:\n${sectionText}\n\nTranscript:\n{transcript}`;
  };

  const handleSave = async () => {
    if (!name.trim() || selectedSections.length === 0) return;
    setSaving(true);
    try {
      await onSave(name.trim(), meetingType, selectedSections, buildPrompt());
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card variant="highlighted" padding="md" className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-iron-text">New Template</h3>
        <button onClick={onCancel} className="p-1 text-iron-text-muted hover:text-iron-text transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-iron-text-muted">Template Name</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g., Weekly Sprint Review"
          className="w-full px-3 py-2 text-sm bg-iron-surface border border-iron-border rounded-lg text-iron-text placeholder:text-iron-text-muted focus:border-iron-accent/30 focus:outline-none"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-iron-text-muted">Meeting Type</label>
        <select
          value={meetingType}
          onChange={e => setMeetingType(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-iron-surface border border-iron-border rounded-lg text-iron-text focus:border-iron-accent/30 focus:outline-none"
        >
          <option value="custom">Custom</option>
          <option value="standup">Standup</option>
          <option value="1on1">1-on-1</option>
          <option value="discovery">Discovery Call</option>
          <option value="team_sync">Team Sync</option>
          <option value="retro">Retrospective</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-iron-text-muted">Sections to Extract</label>
        <div className="flex flex-wrap gap-1.5">
          {SECTION_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => toggleSection(opt.key)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-lg border transition-colors ${
                selectedSections.includes(opt.key)
                  ? 'bg-iron-accent/15 text-iron-accent-light border-iron-accent/20'
                  : 'bg-iron-surface text-iron-text-muted border-iron-border hover:border-iron-border-hover'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-iron-text-muted rounded-lg border border-iron-border hover:bg-iron-surface-hover transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || selectedSections.length === 0 || saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-iron-accent text-white rounded-lg hover:bg-iron-accent-hover transition-colors disabled:opacity-50"
        >
          <Plus className="w-3 h-3" />
          {saving ? 'Creating...' : 'Create Template'}
        </button>
      </div>
    </Card>
  );
}
