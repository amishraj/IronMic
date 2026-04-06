interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'elevated' | 'highlighted' | 'interactive';
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const variantStyles = {
  default: 'bg-iron-surface border border-iron-border',
  elevated: 'bg-iron-surface border border-iron-border shadow-depth',
  highlighted: 'bg-iron-surface border border-iron-accent/20 shadow-glow',
  interactive: 'bg-iron-surface border border-iron-border hover:border-iron-border-hover hover:shadow-depth-sm transition-all cursor-pointer',
};

const paddingStyles = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
};

export function Card({ variant = 'default', padding = 'md', className = '', children, ...props }: CardProps) {
  return (
    <div
      className={`rounded-xl ${variantStyles[variant]} ${paddingStyles[padding]} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex items-center justify-between mb-3 ${className}`}>
      {children}
    </div>
  );
}

export function CardTitle({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {icon && <span className="text-iron-text-secondary">{icon}</span>}
      <h3 className="text-sm font-semibold text-iron-text">{children}</h3>
    </div>
  );
}

export function CardDescription({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-iron-text-muted mt-1">{children}</p>;
}
