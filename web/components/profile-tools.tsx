'use client';
import { useTranslations } from '../i18n/provider';
import { notify as setNotice, notifyError } from '../lib/notifications';
import { RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Profile } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';

interface ToolItem {
  name: string;
  description: string;
  capability: string | null;
  enabled: boolean;
}
const groups: Record<string, string> = {
  web: 'Búsqueda web y lectura de páginas',
  transcription: 'Transcripción y archivos multimedia',
  calendar: 'Google Calendar',
  tasks: 'Tareas',
  documents: 'Google Docs / Drive',
  homeAssistant: 'Home Assistant',
  general: 'General',
};

/** Lets the admin choose which of the profile's available tools the assistant can see. */
export function ProfileTools({ profile, active }: { profile: Profile; active: boolean }) {
  const t = useTranslations();
  const [tools, setTools] = useState<ToolItem[]>();
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const path =
    '/v1/admin/profiles/' + profile.bot + '/' + encodeURIComponent(profile.chatId) + '/tools';
  useEffect(() => {
    if (!active || tools) return;
    api<{ tools: ToolItem[] }>(path)
      .then((result) => {
        const off = new Set(result.tools.filter((tool) => !tool.enabled).map((tool) => tool.name));
        setTools(result.tools);
        setDisabled(off);
        setSaved(off);
      })
      .catch((error) =>
        notifyError(error instanceof Error ? error.message : t('No se pudieron cargar.')),
      );
  }, [active, tools, path, t]);
  const grouped = useMemo(() => {
    const query = search.trim().toLowerCase();
    const result = new Map<string, ToolItem[]>();
    for (const tool of tools || []) {
      if (query && !(tool.name + ' ' + tool.description).toLowerCase().includes(query)) continue;
      const key = tool.capability || 'general';
      result.set(key, [...(result.get(key) || []), tool]);
    }
    return [...result.entries()].sort(([a], [b]) =>
      a === 'general' ? -1 : b === 'general' ? 1 : a.localeCompare(b),
    );
  }, [tools, search]);
  const changed = disabled.size !== saved.size || [...disabled].some((name) => !saved.has(name));
  const toggle = (names: string[], on: boolean) =>
    setDisabled((value) => {
      const next = new Set(value);
      for (const name of names) {
        if (on) next.delete(name);
        else next.add(name);
      }
      return next;
    });
  async function save() {
    setBusy(true);
    try {
      await api(path, 'PUT', { disabled: [...disabled] });
      setSaved(new Set(disabled));
      setNotice(t('Herramientas guardadas.'));
    } catch (error) {
      notifyError(error instanceof Error ? error.message : t('No se pudo guardar.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section profile-tools">
      <h3>{t('Herramientas')}</h3>
      <p>
        {t(
          'Elige qué herramientas puede usar el asistente con este perfil. Solo aparecen las que permiten sus capacidades y conexiones.',
        )}
      </p>
      <div className="profile-tools-toolbar">
        <Input
          type="search"
          aria-label={t('Buscar herramientas')}
          placeholder={t('Buscar herramientas')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {tools && (
          <span className="settings-help">
            {tools.length - disabled.size} / {tools.length} {t('activas')}
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={busy || !changed}
          onClick={() => setDisabled(new Set(saved))}
          tooltip={t('Descartar cambios')}
        >
          <RotateCcw />
        </Button>
        <Button
          type="button"
          size="icon"
          disabled={busy || !changed}
          onClick={() => void save()}
          tooltip={t('Guardar herramientas')}
        >
          <Save />
        </Button>
      </div>
      {!tools ? (
        <p className="settings-help">{t('Cargando…')}</p>
      ) : (
        grouped.map(([key, items]) => {
          const allOn = items.every((tool) => !disabled.has(tool.name));
          return (
            <fieldset key={key} className="profile-tools-group">
              <legend>
                <span>{t(groups[key] || key)}</span>
                <Switch
                  aria-label={t('Activar o desactivar todo el grupo')}
                  checked={allOn}
                  onCheckedChange={(on) =>
                    toggle(
                      items.map((tool) => tool.name),
                      on,
                    )
                  }
                />
              </legend>
              {items.map((tool) => (
                <label key={tool.name} className="profile-tool">
                  <Switch
                    checked={!disabled.has(tool.name)}
                    onCheckedChange={(on) => toggle([tool.name], on)}
                  />
                  <span>
                    <code>{tool.name}</code>
                    <small title={tool.description}>{tool.description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          );
        })
      )}
    </section>
  );
}
