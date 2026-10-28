'use client';
import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from './ui/command';
const defaultLanguages = ['es-ES', 'en-US', 'en-GB', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'pt-PT'];
const names = new Intl.DisplayNames(['es'], { type: 'language' });
function languageName(code: string) {
  try { return names.of(code.replaceAll('_', '-')) || code; } catch { return code; }
}
export function SpeechLanguagePicker({ id, label, value, languages, useDefaultLanguages, disabled, onChange }: {
  id: string; label: string; value: string; languages: string[]; useDefaultLanguages: boolean; disabled: boolean; onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const choices = [...new Set([value, ...(useDefaultLanguages ? defaultLanguages : languages)])].filter(Boolean);
  return <div className="settings-field">
    <Label id={id + '-label'} htmlFor={id}>{label}</Label>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-labelledby={id + '-label'} aria-expanded={open} disabled={disabled} className="w-full justify-between">
          <span className="truncate">{languageName(value)} · {value}</span><ChevronsUpDown className="shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <Command>
          <CommandInput placeholder="Buscar idioma…" aria-label={'Buscar ' + label.toLowerCase()} />
          <CommandList>
            <CommandEmpty>Sin idiomas que coincidan.</CommandEmpty>
            {choices.map((code) => <CommandItem key={code} value={code + ' ' + languageName(code)} onSelect={() => { onChange(code); setOpen(false); }}>
              <span className="min-w-0 flex-1">{languageName(code)} · {code}</span>
              {code === value && <Check className="size-4 shrink-0" />}
            </CommandItem>)}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  </div>;
}
