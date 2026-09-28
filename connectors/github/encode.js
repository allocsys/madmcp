// ---------------------------------------------------------------------------
// connectors/github/encode.js — URL path-segment encoding helpers
//
// Deliberately dependency-free (no imports) so any connector module can use
// it without pulling in client.js, which several tests mock wholesale.
// ---------------------------------------------------------------------------

// Encodes a git ref / branch name for use inside a URL path. Each segment is
// percent-encoded but '/' is kept as the separator, which is the form GitHub
// documents for ref endpoints (e.g. /git/ref/heads/feature/x). A plain
// encodeURIComponent(ref) would turn 'feature/x' into 'feature%2Fx'.
export function encodeRef(ref) {
  return String(ref).split("/").map(encodeURIComponent).join("/");
}

// Encodes a single path segment (codespace name, workflow id, etc.).
export function encodeSegment(value) {
  return encodeURIComponent(String(value));
}
