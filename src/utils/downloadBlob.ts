/**
 * Download a blob from a fetch Response.
 * Parses Content-Disposition header for filename, creates a temporary anchor,
 * clicks it, then cleans up.
 *
 * @returns The resolved filename (from header or defaultName fallback).
 */
export async function downloadBlobFromResponse(
  res: Response,
  defaultName: string,
): Promise<string> {
  const blob = await res.blob()
  const contentDisposition = res.headers.get('Content-Disposition')
  let filename = defaultName
  if (contentDisposition) {
    const match = contentDisposition.match(/filename="?([^"]+)"?/)
    if (match) filename = match[1]
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  return filename
}
