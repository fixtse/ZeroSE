export function TimezoneOptions({ id }: { id: string }) {
  return (
    <datalist id={id}>
      {Intl.supportedValuesOf('timeZone').map((zone) => (
        <option key={zone} value={zone} />
      ))}
      <option value="UTC" />
    </datalist>
  );
}
