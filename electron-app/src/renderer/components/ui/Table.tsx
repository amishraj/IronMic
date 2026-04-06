interface TableProps {
  children: React.ReactNode;
  className?: string;
}

export function Table({ children, className = '' }: TableProps) {
  return (
    <div className={`overflow-x-auto rounded-xl border border-iron-border ${className}`}>
      <table className="w-full text-sm">
        {children}
      </table>
    </div>
  );
}

export function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="bg-iron-bg/50 border-b border-iron-border">
      {children}
    </thead>
  );
}

export function TableRow({ children, className = '', onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <tr
      className={`border-b border-iron-border last:border-0 transition-colors ${
        onClick ? 'cursor-pointer hover:bg-iron-surface-hover' : ''
      } ${className}`}
      onClick={onClick}
    >
      {children}
    </tr>
  );
}

export function TableHeader({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-4 py-3 text-left text-xs font-medium text-iron-text-muted uppercase tracking-wider ${className}`}>
      {children}
    </th>
  );
}

export function TableCell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`px-4 py-3 text-iron-text ${className}`}>
      {children}
    </td>
  );
}
