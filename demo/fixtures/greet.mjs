export function greet(name) {
  const trimmed = name == null ? "" : String(name).trim();
  if (!trimmed) throw new Error("greet requires a name");
  return `Hello, ${trimmed}!`;
}
