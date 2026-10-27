export function secretHint(value?: string) {
  return value
    ? value.length > 12
      ? value.slice(0, 4) + '••••••••' + value.slice(-4)
      : '••••••••'
    : undefined;
}
