import { List, PenTool } from 'lucide-react';
import type { ViewMode } from '../types';

interface ViewToggleProps {
  currentView: ViewMode;
  onViewChange: (view: ViewMode) => void;
}

export function ViewToggle({ currentView, onViewChange }: ViewToggleProps) {
  return (
    <div className="flex items-center bg-iron-bg/50 border border-iron-border rounded-lg p-0.5">
      <ToggleBtn active={currentView === 'timeline'} onClick={() => onViewChange('timeline')} icon={<List className="w-3.5 h-3.5" />} label="Timeline" />
      <ToggleBtn active={currentView === 'editor'} onClick={() => onViewChange('editor')} icon={<PenTool className="w-3.5 h-3.5" />} label="Editor" />
    </div>
  );
}

function ToggleBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
        active
          ? 'bg-iron-surface-hover text-iron-text shadow-depth-sm'
          : 'text-iron-text-muted hover:text-iron-text-secondary'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
