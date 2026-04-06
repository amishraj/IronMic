interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  variant?: 'default' | 'accent' | 'warning';
  disabled?: boolean;
}

export function Toggle({ checked, onChange, variant = 'default', disabled }: ToggleProps) {
  const activeColors = {
    default: 'rgb(var(--iron-accent))',
    accent: 'rgb(var(--iron-accent))',
    warning: 'rgb(var(--iron-warning))',
  };

  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{
        position: 'relative',
        width: 44,
        height: 24,
        borderRadius: 12,
        backgroundColor: checked ? activeColors[variant] : 'rgb(var(--iron-surface-active))',
        border: checked ? 'none' : '1px solid rgb(var(--iron-border) / var(--iron-border-alpha))',
        transition: 'background-color 0.2s, border-color 0.2s',
        flexShrink: 0,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: checked ? '0 0 12px rgb(var(--iron-accent) / 0.2)' : 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 23 : 3,
          width: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: '#FFFFFF',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 0.2s ease',
        }}
      />
    </button>
  );
}
