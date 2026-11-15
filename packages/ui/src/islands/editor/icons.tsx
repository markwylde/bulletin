/** Inline SVG icons for the editor toolbar (ADR 0021: inline SVG, no glyphs or icon fonts). */

const PATHS = {
  bold: "M6 4h5a3 3 0 0 1 0 6H6zM6 10h6a3 3 0 0 1 0 6H6z",
  italic: "M12 4H8m4 12H8m3.5-12-3 12",
  heading: "M5 4v12M15 4v12M5 10h10",
  link: "M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1",
  code: "M7 6l-4 4 4 4M13 6l4 4-4 4",
  quote: "M4 5h12M4 10h12M4 15h8M2 4v12",
  spoiler:
    "M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5zM10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM3 17 17 3",
  list: "M8 5h9M8 10h9M8 15h9M3.5 5h.01M3.5 10h.01M3.5 15h.01",
  emoticon:
    "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM7 12s1 1.5 3 1.5 3-1.5 3-1.5M7.5 8h.01M12.5 8h.01",
  mention: "M13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm0 0v1.2a2 2 0 0 0 4 0V10a7 7 0 1 0-2.8 5.6",
  attach:
    "M16 9.5l-6.4 6.4a4 4 0 0 1-5.7-5.7l6.4-6.4a2.7 2.7 0 0 1 3.8 3.8L7.7 14a1.3 1.3 0 0 1-1.9-1.9l5.8-5.8",
} as const;

export type EditorIconName = keyof typeof PATHS;

export function EditorIcon({ name }: { readonly name: EditorIconName }) {
  return (
    <svg
      className="bl-icon"
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
