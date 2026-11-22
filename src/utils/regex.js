/**
 * Escapes regex metacharacters from untrusted user text prior to MongoDB `$regex`.
 */
export function escapeRegexInput(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
