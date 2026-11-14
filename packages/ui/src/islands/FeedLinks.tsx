import { FlagsProvider, useFlag } from "../flags.tsx";

export interface FeedLinksProps {
  readonly flags: { readonly feeds: boolean };
  readonly labels: {
    readonly label: string;
    readonly rss: string;
    readonly atom: string;
  };
}

function FeedLinkList({ labels }: Pick<FeedLinksProps, "labels">) {
  const enabled = useFlag("feeds");

  if (!enabled) {
    return null;
  }

  return (
    <nav className="bl-footer__feeds" aria-label={labels.label} data-feed-links>
      <a href="/feed.xml" rel="alternate" type="application/rss+xml">
        {labels.rss}
      </a>
      <span aria-hidden="true"> · </span>
      <a href="/feed.atom" rel="alternate" type="application/atom+xml">
        {labels.atom}
      </a>
    </nav>
  );
}

/** Footer feed discovery links, gated by the `feeds` flag on the server and after hydration. */
export function FeedLinks({ flags, labels }: FeedLinksProps) {
  return (
    <FlagsProvider value={{ feeds: flags.feeds }}>
      <FeedLinkList labels={labels} />
    </FlagsProvider>
  );
}
