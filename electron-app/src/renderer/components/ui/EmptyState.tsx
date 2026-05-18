import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

/**
 * Consistent empty state placeholder for pages with no content.
 */
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-14 h-14 rounded-2xl bg-iron-accent/10 flex items-center justify-center mb-4">
        <Icon className="w-7 h-7 text-iron-accent-light" />
      </div>
      <p className="text-sm font-medium text-iron-text">{title}</p>
      {description && (
        <p className="text-xs text-iron-text-muted mt-1.5 max-w-[300px] leading-relaxed">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 px-4 py-2 text-xs font-medium bg-iron-accent/10 text-iron-accent-light rounded-lg border border-iron-accent/20 hover:bg-iron-accent/20 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
