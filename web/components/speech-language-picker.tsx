'use client';
import { useTranslations } from '../i18n/provider';
import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from './ui/command';
const defaultLanguages = ['es-ES', 'en-US', 'en-GB', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'pt-PT'];
function languageName(code: string, locale: string) {
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  try {
    return names.of(code.replaceAll('_', '-')) || code;
  } catch {
    return code;
  }
}
export function SpeechLanguagePicker({
  id,
  label,
  value,
  languages,
  useDefaultLanguages,
  disabled,
  onChange,
  allowAutomatic = false,
  name,
}: {
  id: string;
  label: string;
  value: string;
  languages: string[];
  useDefaultLanguages: boolean;
  disabled: boolean;
  onChange(value: string): void;
  allowAutomatic?: boolean;
  name?: string;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const selected = allowAutomatic && (!value || value.toLowerCase() === 'auto') ? '' : value;
  const choices = [
    ...new Set([selected, ...(useDefaultLanguages ? defaultLanguages : languages)]),
  ].filter(Boolean);
  if (allowAutomatic) choices.unshift('');
  const choiceLabel = (code: string) =>
    code
      ? languageName(code, t.locale) + ' · ' + code
      : t(allowAutomatic ? 'Detectar automáticamente' : 'Seleccionar…');
  return (
    <div className="settings-field">
      <Label id={id + '-label'} htmlFor={id}>
        {label}
      </Label>
      {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-labelledby={id + '-label'}
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between"
          >
            <span className="truncate">{choiceLabel(selected)}</span>
            <ChevronsUpDown className="shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <Command>
            <CommandInput
              placeholder={t('Buscar idioma…')}
              aria-label={t('Buscar ') + label.toLowerCase()}
            />
            <CommandList>
              <CommandEmpty>{t('Sin idiomas que coincidan.')}</CommandEmpty>
              {choices.map((code) => (
                <CommandItem
                  key={code}
                  value={(code || 'auto') + ' ' + choiceLabel(code)}
                  onSelect={() => {
                    onChange(code);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">{choiceLabel(code)}</span>
                  {code === selected && <Check className="size-4 shrink-0" />}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
