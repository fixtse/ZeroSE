/**
 * Shared by Next's route fallback and the client-side session check. It renders before
 * the stylesheet loads, so its styles live in the critical CSS in `app/layout.tsx`.
 * The layout is neutral (no login card or sidebar) so neither signed-in nor signed-out
 * users see the page jump when the real view replaces it.
 */
export function PageSkeleton({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="page-loading" role="status" aria-live="polite" aria-busy="true">
      <div className="page-loading-mark">
        {/* Relative path: works under /admin/ and behind Home Assistant Ingress. */}
        <img src="zero-logo.webp" width={56} height={56} alt="" fetchPriority="high" />
        <span className="page-loading-word" aria-hidden="true">
          zero<span>SE</span>
        </span>
        <span className="page-loading-bar" aria-hidden="true">
          <span />
        </span>
        <span className="page-loading-label">{label}</span>
      </div>
    </div>
  );
}
