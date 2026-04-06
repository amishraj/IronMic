import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-accent hover:bg-gradient-accent-hover text-white shadow-depth-sm hover:shadow-glow active:shadow-none',
  secondary:
    'bg-iron-surface border border-iron-border text-iron-text hover:bg-iron-surface-hover hover:border-iron-border-hover',
  ghost:
    'bg-transparent text-iron-text-secondary hover:text-iron-text hover:bg-iron-surface-hover',
  danger:
    'bg-iron-danger/10 text-iron-danger border border-iron-danger/20 hover:bg-iron-danger/20 hover:shadow-glow-danger',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'text-xs px-2.5 py-1.5 gap-1.5 rounded',
  md: 'text-sm px-3.5 py-2 gap-2 rounded-lg',
  lg: 'text-sm px-5 py-2.5 gap-2 rounded-xl',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, icon, children, disabled, className = '', ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`
          inline-flex items-center justify-center font-medium transition-all duration-150
          focus-ring disabled:opacity-40 disabled:cursor-not-allowed
          ${variantStyles[variant]} ${sizeStyles[size]} ${className}
        `}
        {...props}
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
