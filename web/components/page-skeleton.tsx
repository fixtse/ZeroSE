import { Skeleton } from './ui/skeleton';

/** Shared by Next's route fallback and the client-side session check. No protected navigation. */
export function PageSkeleton({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="page-loading" role="status" aria-label={label} aria-busy="true">
      <div aria-hidden="true">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '24px' }}>
          <Skeleton style={{ width: 39, height: 39 }} />
          <Skeleton style={{ width: 76, height: 24 }} />
        </div>
        <div
          style={{
            boxSizing: 'border-box',
            width: 'min(510px, calc(100% - 32px))',
            margin: 'clamp(32px, 8vh, 80px) auto',
            padding: 'clamp(24px, 5vw, 40px)',
            border: '1px solid #1e293b',
            borderRadius: 12,
            background: '#0f172a',
            display: 'grid',
            gap: 24,
          }}
        >
          <div style={{ display: 'grid', gap: 12 }}>
            <Skeleton style={{ width: '70%', height: 32 }} />
            <Skeleton style={{ width: '90%', height: 16 }} />
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <Skeleton style={{ width: 96, height: 14 }} />
            <Skeleton style={{ width: '100%', height: 40 }} />
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <Skeleton style={{ width: 80, height: 14 }} />
            <Skeleton style={{ width: '100%', height: 40 }} />
          </div>
          <Skeleton style={{ width: '100%', height: 40 }} />
        </div>
      </div>
    </div>
  );
}
