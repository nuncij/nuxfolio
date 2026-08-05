import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <h1 className="text-xl font-semibold text-ink">Page not found</h1>
      <p className="mt-2 text-sm text-ink-muted">
        The page you asked for does not exist. Portfolio links look like
        <code className="numeric mx-1 rounded bg-surface px-1.5 py-0.5 text-xs">
          /portfolio/0x…
        </code>
        .
      </p>
      <Link href="/" className="mt-6 inline-block text-sm text-accent hover:underline">
        Back to start
      </Link>
    </div>
  );
}
