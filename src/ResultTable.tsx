import { useEffect, useRef } from 'react';
import type { Row } from './scenes';
import { fmt } from './geo';

type Props = {
  columns: string[];
  rows: Row[];
  hoveredKey: string | null;
  onHover: (key: string | null) => void;
  onRowClick?: (row: Row) => void;
};

export function ResultTable({ columns, rows, hoveredKey, onHover, onRowClick }: Props) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hoveredKey || !body.current) return;
    const el = body.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(hoveredKey)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [hoveredKey]);

  if (!rows.length) return <div className="table-empty">Results appear here as the query runs.</div>;

  return (
    <div className="table-wrap" ref={body}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              data-key={r.key}
              className={r.key === hoveredKey ? 'hover' : ''}
              onMouseEnter={() => onHover(r.key)}
              onMouseLeave={() => onHover(null)}
              onClick={() => onRowClick?.(r)}
              tabIndex={onRowClick ? 0 : -1}
              onKeyDown={(e) => e.key === 'Enter' && onRowClick?.(r)}
            >
              {columns.map((c) => {
                const v = r.cells[c];
                const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : fmt(v)) : (v ?? '');
                return (
                  <td key={c} className={typeof v === 'number' ? 'num' : ''} title={s.length > 40 ? s : undefined}>
                    {s}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
