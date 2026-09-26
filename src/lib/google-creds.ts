// Robust parser for the Google service-account credential JSON.
//
// GOOGLE_SERVICE_ACCOUNT_JSON is frequently stored with the private_key's
// real newlines left UNescaped inside the string literal, which makes
// JSON.parse throw "Bad control character in string literal". This parser
// falls back to escaping control characters that appear inside string
// literals (leaving structural whitespace untouched) so it works whether the
// env value is clean or malformed.

type Creds = Record<string, unknown>;
let cached: Creds | null = null;

export function parseServiceAccount(): Creds {
  if (cached) return cached;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");

  try {
    cached = JSON.parse(raw) as Creds;
    return cached;
  } catch {
    // Escape raw control chars that occur INSIDE double-quoted strings only.
    let out = "";
    let inStr = false;
    let esc = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = !inStr; out += ch; continue; }
      if (inStr) {
        if (ch === "\n") { out += "\\n"; continue; }
        if (ch === "\r") { out += "\\r"; continue; }
        if (ch === "\t") { out += "\\t"; continue; }
      }
      out += ch;
    }
    cached = JSON.parse(out) as Creds;
    return cached;
  }
}
