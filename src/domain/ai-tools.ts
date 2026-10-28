/**
 * Explicit model-name policy, not capability discovery. Unknown model names retain
 * application web tools; image search and private integrations remain independent.
 */
export function modelAllowsApplicationTool(model: string | undefined, tool: string): boolean {
  if (tool !== 'url_read' && tool !== 'web_search') return true;
  const match = /^(?:openai\/)?gpt-?(\d+)(?=$|[.\-:])/i.exec(model || '');
  return !match || Number(match[1]) < 5;
}
