type BadgeVariant = 'default' | 'accent' | 'success' | 'warning' | 'danger';

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-iron-surface-active text-iron-text-secondary',
  accent: 'bg-iron-accent/10 text-iron-accent-light border border-iron-accent/20',
  success: 'bg-iron-success/10 text-iron-success border border-iron-success/20',
  warning: 'bg-iron-warning/10 text-iron-warning border border-iron-warning/20',
  danger: 'bg-iron-danger/10 text-iron-danger border border-iron-danger/20',
};

export function Badge({ variant = 'default', children, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${variantStyles[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
