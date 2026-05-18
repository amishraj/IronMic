import type { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  icon: LucideIcon;
  iconColor?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * Unified page header used across all pages for consistent visual treatment.
 * Renders an icon badge + title + optional description + right-aligned actions slot.
 */
export function PageHeader({ icon: Icon, iconColor = 'iron-accent', title, description, actions, children }: PageHeaderProps) {
  // Map color names to Tailwind classes (can't use dynamic string interpolation)
  const colorMap: Record<string, { bg: string; text: string }> = {
    'iron-accent': { bg: 'bg-iron-accent/10', text: 'text-iron-accent-light' },
    'emerald-500': { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
    'blue-500': { bg: 'bg-blue-500/10', text: 'text-blue-400' },
    'purple-500': { bg: 'bg-purple-500/10', text: 'text-purple-400' },
    'amber-500': { bg: 'bg-amber-500/10', text: 'text-amber-400' },
    'red-500': { bg: 'bg-red-500/10', text: 'text-red-400' },
  };

  const colors = colorMap[iconColor] || colorMap['iron-accent'];

  return (
    <div className="px-5 pt-4 pb-3 border-b border-iron-border">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl ${colors.bg} flex items-center justify-center flex-shrink-0`}>
            <Icon className={`w-[18px] h-[18px] ${colors.text}`} />
          </div>
          <div>
            <h2 className="text-base font-semibold text-iron-text">{title}</h2>
            {description && (
              <p className="text-[11px] text-iron-text-muted mt-0.5">{description}</p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex items-center gap-2">
            {actions}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
