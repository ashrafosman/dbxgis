import type { ReactNode } from 'react';
import type { Clause } from './scenes';

const KEYWORDS = new Set(
  'SELECT FROM WHERE JOIN LEFT CROSS ON AS GROUP BY ORDER DESC ASC WITH CREATE TABLE OR REPLACE QUALIFY OVER PARTITION AND USING ALL GRANT TO LIMIT DISTINCT'.split(' '),
);

export function highlightSql(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(--.*$)|('[^']*')|(`[^`]*`)|\b(ST_\w+|h3_\w+|COUNT|ROW_NUMBER|explode|SUM)\b|\b(\d+(?:\.\d+)?(?:e\d+)?)\b|\b([A-Z]{2,})\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const [tok] = m;
    let cls = '';
    if (m[1]) cls = 'tk-comment';
    else if (m[2] || m[3]) cls = 'tk-str';
    else if (m[4]) cls = m[4].startsWith('ST_') || m[4].startsWith('h3_') ? 'tk-geo' : 'tk-fn';
    else if (m[5]) cls = 'tk-num';
    else if (m[6] && KEYWORDS.has(m[6])) cls = 'tk-kw';
    out.push(cls ? <span key={i++} className={cls}>{tok}</span> : tok);
    last = m.index + tok.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function SqlPanel({ clauses, active, finished }: { clauses: Clause[]; active: number; finished: boolean }) {
  return (
    <pre className="sql" aria-label="SQL">
      {clauses.map((c, i) => {
        const state = finished || c.stage < active ? 'done' : c.stage === active ? 'live' : 'todo';
        return (
          <div key={i} className={`sql-line ${state}`}>
            <span className="sql-gutter" aria-hidden>{i + 1}</span>
            <code>{highlightSql(c.text)}</code>
          </div>
        );
      })}
    </pre>
  );
}
