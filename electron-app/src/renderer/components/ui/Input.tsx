import { forwardRef } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ icon, error, className = '', ...props }, ref) => {
    return (
      <div className="relative">
        {icon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-iron-text-muted">
            {icon}
          </span>
        )}
        <input
          ref={ref}
          className={`
            w-full text-sm bg-iron-bg border border-iron-border rounded-lg
            text-iron-text placeholder:text-iron-text-muted
            transition-all duration-150
            hover:border-iron-border-hover
            focus:outline-none focus:border-iron-accent/50 focus:shadow-glow
            disabled:opacity-40 disabled:cursor-not-allowed
            ${icon ? 'pl-9' : 'pl-3'} pr-3 py-2
            ${error ? 'border-iron-danger/50 focus:border-iron-danger/50 focus:shadow-glow-danger' : ''}
            ${className}
          `}
          {...props}
        />
        {error && (
          <p className="mt-1 text-xs text-iron-danger">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ error, className = '', children, ...props }, ref) => {
    return (
      <div>
        <select
          ref={ref}
          className={`
            w-full text-sm bg-iron-bg border border-iron-border rounded-lg
            text-iron-text
            transition-all duration-150
            hover:border-iron-border-hover
            focus:outline-none focus:border-iron-accent/50 focus:shadow-glow
            disabled:opacity-40 disabled:cursor-not-allowed
            px-3 py-2 appearance-none
            ${error ? 'border-iron-danger/50' : ''}
            ${className}
          `}
          {...props}
        >
          {children}
        </select>
        {error && (
          <p className="mt-1 text-xs text-iron-danger">{error}</p>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';
