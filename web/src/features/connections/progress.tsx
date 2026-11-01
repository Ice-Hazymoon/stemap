export const Progress = ({ value }: { value: number }) => (
  <div className="h-1 overflow-hidden bg-muted" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
    <div className="h-full bg-muted-foreground" style={{ width: `${value}%` }} />
  </div>
);
