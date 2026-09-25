export function trimBase(base) {
  return base.replace(/\/+$/, "");
}

export async function getJSON(base, path, signal) {
  const response = await fetch(`${trimBase(base)}${path}`, { signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}
