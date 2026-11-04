'use client';
import { useTranslations } from '../i18n/provider';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { api, type Profile } from '../lib/api';
import { useUrlState } from '../hooks/use-url-state';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './ui/alert-dialog';

interface MemoryItem {
  id: string;
  summary: string;
  category: string;
  tags: string[];
  created: string;
  expires_at?: string;
  expired?: boolean;
}
interface MemoryPage {
  items: MemoryItem[];
  total: number;
  next_offset: number | null;
  enabled: boolean;
  shared: boolean;
  linked: boolean;
}
interface MemoryDetail {
  id: string;
  text: string;
  metadata: {
    category: string;
    tags: string[];
    created_at: string;
    expires_at?: string;
    entities?: string[];
    relations?: { subject: string; predicate: string; object: string }[];
  };
  superseded_by: string | null;
  next_offset: number | null;
  total_characters: number;
}

function localDateTime(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function navigate(values: Record<string, string | null>) {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function ProfileMemory({ profile, active }: { profile: Profile; active: boolean }) {
  const t = useTranslations();
  const [search] = useUrlState('memorySearch', '');
  const [category] = useUrlState('memoryCategory', '');
  const [pageNumber] = useUrlState('memoryPage', '0');
  const [selected] = useUrlState('memoryId', '');
  const [edit] = useUrlState('memoryEdit', '');
  const [draftSearch, setDraftSearch] = useState(search);
  const [draftCategory, setDraftCategory] = useState(category);
  const [page, setPage] = useState<MemoryPage>();
  const [detail, setDetail] = useState<MemoryDetail>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [deleting, setDeleting] = useState<{ id: string; summary: string }>();
  const [text, setText] = useState('');
  const [memoryCategory, setMemoryCategory] = useState('General');
  const [tags, setTags] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [entities, setEntities] = useState('');
  const [relations, setRelations] = useState('');
  const { busy, run, setNotice } = useAdminTask();
  const path =
    '/v1/admin/profiles/' + profile.bot + '/' + encodeURIComponent(profile.chatId) + '/memories';
  const mounted = useRef(true);
  const selection = useRef({ path, selected });
  selection.current = { path, selected };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const offset = /^\d{1,7}$/.test(pageNumber) ? Number(pageNumber) : 0;
  const composing = selected === 'new' || (!!selected && edit === '1');
  const enabled = page?.enabled ?? profile.memoryMode !== 'none';

  useEffect(() => {
    setDraftSearch(search);
    setDraftCategory(category);
  }, [search, category]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ search, category, offset: String(offset), limit: '20' });
    void api<MemoryPage>(path + '?' + params, 'GET', undefined, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (offset && offset >= result.total) {
          navigate({
            memoryPage: result.total ? String(Math.floor((result.total - 1) / 20) * 20) : null,
          });
        } else setPage(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : t('No se pudo consultar la memoria.'),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, path, search, category, offset, refresh]);

  useEffect(() => {
    setDetail(undefined);
    setText('');
    setMemoryCategory('General');
    setTags('');
    setExpiresAt('');
    setEntities('');
    setRelations('');
    if (!selected || selected === 'new') return;
    const controller = new AbortController();
    void api<MemoryDetail>(
      path + '/' + encodeURIComponent(selected),
      'GET',
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : t('No se pudo abrir el recuerdo.'));
      });
    return () => controller.abort();
  }, [path, selected, refresh]);

  useEffect(() => {
    if (edit === '1' && detail) {
      setText(detail.text);
      setMemoryCategory(detail.metadata.category);
      setTags(detail.metadata.tags.join(', '));
      setExpiresAt(detail.metadata.expires_at ? localDateTime(detail.metadata.expires_at) : '');
      setEntities((detail.metadata.entities || []).join(', '));
      setRelations(
        (detail.metadata.relations || [])
          .map((item) => [item.subject, item.predicate, item.object].join(' | '))
          .join('\n'),
      );
    }
  }, [edit, detail]);

  function applySearch() {
    navigate({
      memorySearch: draftSearch.trim() || null,
      memoryCategory: draftCategory.trim() || null,
      memoryPage: null,
      memoryId: null,
      memoryEdit: null,
    });
    setRefresh((value) => value + 1);
  }
  const date = (value: string) =>
    new Date(value).toLocaleDateString(t.locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: profile.timezone || 'Europe/Madrid',
    });

  return (
    <section className="profile-memory" aria-label={t('Memoria de ') + profile.label}>
      <div className="memory-heading">
        <div>
          <h3>
            {t('Memoria del')} {profile.kind === 'group' ? 'grupo' : 'usuario'}
          </h3>
          <p>{t('Recuerdos que el asistente puede recuperar en futuras conversaciones.')}</p>
        </div>
        <Button
          type="button"
          size="icon"
          tooltip={t('Añadir recuerdo')}
          disabled={busy || !enabled}
          onClick={() => navigate({ memoryId: 'new', memoryEdit: null })}
        >
          <Plus />
        </Button>
      </div>
      {!enabled && (
        <p className="memory-scope-note">
          {t('La memoria está desactivada. Puedes consultar y eliminar los recuerdos guardados.')}
        </p>
      )}
      {page?.shared && (
        <p className="memory-scope-note">
          {t('Este perfil utiliza la memoria compartida configurada para el administrador.')}
        </p>
      )}
      {page?.linked && (
        <p className="memory-scope-note">
          {t('Se muestra la memoria del usuario de Telegram vinculado a esta cuenta.')}
        </p>
      )}
      <div className="memory-filters">
        <div>
          <Label htmlFor="memory-search">{t('Buscar recuerdos')}</Label>
          <Input
            id="memory-search"
            value={draftSearch}
            maxLength={300}
            placeholder={t('Texto o etiqueta')}
            onChange={(event) => setDraftSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applySearch();
              }
            }}
          />
        </div>
        <div>
          <Label htmlFor="memory-category-filter">{t('Categoría')}</Label>
          <Input
            id="memory-category-filter"
            value={draftCategory}
            maxLength={200}
            placeholder={t('Todas')}
            onChange={(event) => setDraftCategory(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applySearch();
              }
            }}
          />
        </div>
        <div className="memory-filter-actions">
          <Button
            type="button"
            variant="outline"
            size="icon"
            tooltip={t('Buscar recuerdos')}
            disabled={busy}
            onClick={applySearch}
          >
            <Search />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            tooltip={t('Actualizar recuerdos')}
            disabled={busy || loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="memory-error">
          {error}
        </p>
      )}
      <div className="profile-memory-layout">
        <div className="memory-list-pane" aria-busy={loading}>
          <p className="memory-count" role="status">
            {loading
              ? t('Consultando recuerdos…')
              : page
                ? `${page.total} ${page.total === 1 ? t('recuerdo') : t('recuerdos')}`
                : t('Memoria')}
          </p>
          {page?.items.length === 0 && (
            <div className="memory-empty">
              <Brain aria-hidden="true" />
              <p>
                {search || category
                  ? t('No hay recuerdos que coincidan con estos filtros.')
                  : t('Este perfil todavía no tiene recuerdos guardados.')}
              </p>
            </div>
          )}
          <ul className="memory-list">
            {page?.items.map((item) => (
              <li key={item.id} data-selected={selected === item.id}>
                <button
                  type="button"
                  className="memory-select"
                  disabled={busy}
                  aria-pressed={selected === item.id}
                  onClick={() => navigate({ memoryId: item.id, memoryEdit: null })}
                >
                  <span className="memory-item-meta">
                    <span>
                      {item.category}
                      {item.expired ? t(' · Caducado') : ''}
                    </span>
                    <time dateTime={item.created}>{date(item.created)}</time>
                  </span>
                  <span className="memory-summary">{item.summary}</span>
                  {item.tags.length > 0 && (
                    <span className="memory-tag-line">
                      {item.tags
                        .slice(0, 4)
                        .map((tag) => '#' + tag)
                        .join(' · ')}
                    </span>
                  )}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  tooltip={t('Eliminar recuerdo')}
                  className="danger"
                  disabled={busy}
                  onClick={() => setDeleting(item)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
          {page && page.total > 20 && (
            <nav className="memory-pagination" aria-label={t('Páginas de recuerdos')}>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                tooltip={t('Recuerdos anteriores')}
                disabled={!offset || loading}
                onClick={() => navigate({ memoryPage: offset > 20 ? String(offset - 20) : null })}
              >
                <ArrowLeft />
              </Button>
              <span>
                {offset + 1}–{Math.min(offset + page.items.length, page.total)} {t('de')}{' '}
                {page.total}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                tooltip={t('Recuerdos siguientes')}
                disabled={page.next_offset === null || loading}
                onClick={() => navigate({ memoryPage: String(page.next_offset) })}
              >
                <ArrowRight />
              </Button>
            </nav>
          )}
        </div>
        <div className="memory-detail-pane">
          {composing ? (
            <>
              <div className="memory-detail-heading">
                <h4>{selected === 'new' ? t('Añadir recuerdo') : t('Corregir recuerdo')}</h4>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  tooltip={t('Cancelar edición del recuerdo')}
                  disabled={busy}
                  onClick={() =>
                    navigate({ memoryId: selected === 'new' ? null : selected, memoryEdit: null })
                  }
                >
                  <X />
                </Button>
              </div>
              {selected !== 'new' && (
                <p className="memory-editor-help">
                  {t(
                    'La corrección sustituye al recuerdo anterior. Conserva quién dijo, recomendó o decidió cada cosa.',
                  )}
                </p>
              )}
              <Label htmlFor="memory-text">{t('Recuerdo')}</Label>
              <Textarea
                id="memory-text"
                value={text}
                maxLength={16000}
                rows={7}
                disabled={busy || !enabled}
                onChange={(event) => setText(event.target.value)}
                placeholder={t('Escribe un hecho o una recomendación con su contexto.')}
              />
              <div className="memory-editor-fields">
                <div>
                  <Label htmlFor="memory-category">{t('Categoría del recuerdo')}</Label>
                  <Input
                    id="memory-category"
                    value={memoryCategory}
                    maxLength={200}
                    disabled={busy || !enabled}
                    onChange={(event) => setMemoryCategory(event.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="memory-tags">{t('Etiquetas')}</Label>
                  <Input
                    id="memory-tags"
                    value={tags}
                    maxLength={1600}
                    disabled={busy || !enabled}
                    placeholder={t('Separadas por comas')}
                    onChange={(event) => setTags(event.target.value)}
                  />
                </div>
              </div>
              <div className="memory-editor-fields">
                <div>
                  <Label htmlFor="memory-expiration">
                    {t('Caducidad (hora de este dispositivo)')}
                  </Label>
                  <Input
                    id="memory-expiration"
                    type="datetime-local"
                    value={expiresAt}
                    disabled={busy || !enabled}
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                  <small>
                    {t(
                      'Vacío: sin caducidad. Al vencer deja de aparecer en las búsquedas; puedes revisarlo y eliminarlo aquí.',
                    )}
                  </small>
                </div>
                <div>
                  <Label htmlFor="memory-entities">{t('Personas, lugares y entidades')}</Label>
                  <Input
                    id="memory-entities"
                    value={entities}
                    maxLength={6000}
                    disabled={busy || !enabled}
                    placeholder={t('Nombres separados por comas')}
                    onChange={(event) => setEntities(event.target.value)}
                  />
                </div>
              </div>
              <Label htmlFor="memory-relations">{t('Relaciones explícitas')}</Label>
              <Textarea
                id="memory-relations"
                rows={3}
                value={relations}
                maxLength={6500}
                disabled={busy || !enabled}
                onChange={(event) => setRelations(event.target.value)}
                placeholder={t('Una por línea: Ana | trabaja en | Acme')}
              />
              <div className="memory-editor-actions">
                <small>
                  {text.length.toLocaleString(t.locale)} {t('/ 16.000 caracteres')}
                </small>
                <Button
                  type="button"
                  size="icon"
                  tooltip={t('Guardar recuerdo')}
                  disabled={
                    busy ||
                    !enabled ||
                    !text.trim() ||
                    !memoryCategory.trim() ||
                    (selected !== 'new' &&
                      (!detail || detail.next_offset !== null || !!detail.superseded_by))
                  }
                  onClick={() =>
                    void run(async () => {
                      const value = {
                        text: text.trim(),
                        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                        entities: [
                          ...new Set(
                            entities
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean),
                          ),
                        ],
                        relations: relations
                          .split('\n')
                          .map((line) => line.trim())
                          .filter(Boolean)
                          .map((line) => {
                            const parts = line.split('|').map((part) => part.trim());
                            if (parts.length !== 3 || parts.some((part) => !part))
                              throw new Error(
                                t(
                                  'Cada relación necesita persona o entidad, relación y entidad de destino, separados por |.',
                                ),
                              );
                            return { subject: parts[0], predicate: parts[1], object: parts[2] };
                          }),
                        category: memoryCategory.trim(),
                        tags: [
                          ...new Set(
                            tags
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean),
                          ),
                        ],
                      };
                      if (value.tags.length > 20 || value.tags.some((tag) => tag.length > 80))
                        throw new Error(t('Usa hasta 20 etiquetas de 80 caracteres como máximo.'));
                      await api(
                        path + (selected === 'new' ? '' : '/' + selected),
                        selected === 'new' ? 'POST' : 'PUT',
                        value,
                      );
                      if (
                        mounted.current &&
                        selection.current.path === path &&
                        selection.current.selected === selected
                      ) {
                        navigate({ memoryId: null, memoryEdit: null, memoryPage: null });
                        setRefresh((value) => value + 1);
                      }
                      setNotice(
                        (selected === 'new'
                          ? t('Recuerdo guardado en ')
                          : t('Recuerdo corregido en ')) +
                          profile.label +
                          '.',
                      );
                    })
                  }
                >
                  <Save />
                </Button>
              </div>
            </>
          ) : detail ? (
            <>
              <div className="memory-detail-heading">
                <div>
                  <h4>{t('Recuerdo')}</h4>
                  <time dateTime={detail.metadata.created_at}>
                    {date(detail.metadata.created_at)}
                  </time>
                </div>
                <div className="memory-detail-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    tooltip={t('Corregir recuerdo')}
                    disabled={
                      busy ||
                      !enabled ||
                      !!detail.superseded_by ||
                      detail.next_offset !== null ||
                      detail.total_characters > 16000
                    }
                    onClick={() => navigate({ memoryEdit: '1' })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    tooltip={t('Eliminar este recuerdo')}
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      setDeleting({ id: detail.id, summary: detail.text.slice(0, 180) })
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              <span className="memory-category-label">{detail.metadata.category}</span>
              {detail.superseded_by && (
                <p className="memory-scope-note">
                  {t('Este recuerdo fue sustituido por una corrección.')}
                </p>
              )}
              {detail.metadata.expires_at && (
                <p className="memory-scope-note">
                  {Date.parse(detail.metadata.expires_at) <= Date.now()
                    ? t('Caducado desde')
                    : t('Caduca el')}{' '}
                  {new Date(detail.metadata.expires_at).toLocaleString(t.locale, {
                    timeZone: profile.timezone || 'Europe/Madrid',
                  })}
                  {t('. Los recuerdos caducados no aparecen en las búsquedas.')}
                </p>
              )}
              <p className="memory-full-text">{detail.text}</p>
              {!!detail.metadata.entities?.length && (
                <p>
                  {t('Entidades:')} {detail.metadata.entities.join(', ')}
                </p>
              )}
              {!!detail.metadata.relations?.length && (
                <ul aria-label={t('Relaciones del recuerdo')}>
                  {detail.metadata.relations.map((relation, index) => (
                    <li key={index}>
                      {relation.subject} · {relation.predicate} · {relation.object}
                    </li>
                  ))}
                </ul>
              )}
              {detail.next_offset !== null && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const next = await api<MemoryDetail>(
                        path + '/' + detail.id + '?text_offset=' + detail.next_offset,
                      );
                      if (
                        mounted.current &&
                        selection.current.path === path &&
                        selection.current.selected === detail.id
                      )
                        setDetail({ ...next, text: detail.text + next.text });
                    })
                  }
                >
                  {t('Cargar más texto')}
                </Button>
              )}
              {detail.metadata.tags.length > 0 && (
                <div className="memory-tags">
                  {detail.metadata.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="memory-empty">
              <Brain aria-hidden="true" />
              <p>
                {selected && !error
                  ? t('Abriendo recuerdo…')
                  : t('Selecciona un recuerdo para consultar su texto completo.')}
              </p>
            </div>
          )}
        </div>
      </div>
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('¿Eliminar este recuerdo?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('Se eliminará de la memoria de')} {profile.label}
              {t('. El historial de conversación se conserva.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="memory-delete-preview">{deleting?.summary.slice(0, 240)}</p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('Cancelar')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (deleting)
                  void run(async () => {
                    await api(path + '/' + deleting.id, 'DELETE');
                    if (selected === deleting.id) navigate({ memoryId: null, memoryEdit: null });
                    setDeleting(undefined);
                    setRefresh((value) => value + 1);
                    setNotice(t('Recuerdo eliminado.'));
                  });
              }}
            >
              {t('Eliminar recuerdo')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
