'use client';
import { useTranslations } from '../i18n/provider';
import { AIEditorCard } from './ai-editor-card';
import { SecretEditor } from './secret-editor';
import { notifyError } from '../lib/notifications';
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  Cpu,
  FlaskConical,
  ListOrdered,
  MessagesSquare,
  DatabaseZap,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Popover } from 'radix-ui';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { api } from '../lib/api';
import { useUrlState } from '../hooks/use-url-state';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Field, SelectField, CheckField } from './settings-fields';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './ui/alert-dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
export interface AIModel {
  id: string;
  label: string;
  provider: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  hasApiKey?: boolean;
  secretHint?: string;
  clearApiKey?: boolean;
  scope?: 'conversation' | 'embeddings' | 'reranking';
}
interface EmbeddingSettings {
  mode: 'default' | 'disabled' | 'gemini' | 'provider';
  provider?: string;
  dimensions?: number;
  model: string;
  baseUrl: string;
  apiKey: string;
  hasApiKey?: boolean;
  secretHint?: string;
  clearApiKey?: boolean;
}
export interface AISettings {
  codexAvailable?: boolean;
  revision: number;
  defaultModel: string;
  providers: Provider[];
  models: AIModel[];
  embeddings?: EmbeddingSettings;
  reranking?: {
    enabled: boolean;
    provider: string;
    model: string;
    api?: 'model' | 'rerank';
    effort?: AIModel['effort'];
  };
  embeddingInfo?: {
    dimensions: number;
    server: { provider: string; model: string; dimensions: number; hasApiKey: boolean };
  };
}
const kinds = {
  codex: 'Codex CLI (sesión actual)',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  compatible: 'OpenAI compatible',
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  home_assistant: 'Home Assistant',
};
export function AISettingsEditor() {
  const t = useTranslations();
  const [value, setValue] = useState<AISettings>();
  const [savedSettings, setSavedSettings] = useState('');
  const [reprocessing, setReprocessing] = useState(false);
  const [progress, setProgress] = useState('');
  const [tab, setTab] = useUrlState('aiTab', 'conversation');
  const [connectionEditor, setConnectionEditor] = useUrlState('aiConnection', '');
  const [modelEditor, setModelEditor] = useUrlState('aiModel', '');
  const [savedProviders, setSavedProviders] = useState<Provider[]>([]);
  const [savedModels, setSavedModels] = useState<AIModel[]>([]);
  const { busy, setNotice, run } = useAdminTask();
  const load = async () => {
    const settings = await api<AISettings>('/v1/admin/ai');
    setValue(settings);
    setSavedSettings(JSON.stringify(settings));
    setSavedProviders(settings.providers);
    setSavedModels(settings.models);
  };
  useEffect(() => {
    void run(load);
  }, []);
  function provider(index: number, patch: Partial<Provider>) {
    setValue(
      (v) =>
        v && {
          ...v,
          providers: v.providers.map((p, i) => (i === index ? { ...p, ...patch } : p)),
          models:
            patch.kind && patch.kind !== v.providers[index].kind
              ? v.models.map((m) =>
                  m.provider === v.providers[index].id
                    ? { ...m, model: '', label: '', effort: undefined }
                    : m,
                )
              : v.models,
        },
    );
  }
  function removeMemoryProvider(id: string) {
    setValue(
      (current) =>
        current && {
          ...current,
          providers: current.providers.filter((provider) => provider.id !== id),
          ...(current.embeddings?.provider === id
            ? {
                embeddings: {
                  ...current.embeddings,
                  mode: 'disabled' as const,
                  provider: undefined,
                },
              }
            : {}),
          ...(current.reranking?.provider === id
            ? { reranking: { ...current.reranking, enabled: false, provider: '', model: '' } }
            : {}),
        },
    );
  }
  function model(index: number, patch: Partial<AIModel>) {
    setValue(
      (v) => v && { ...v, models: v.models.map((m, i) => (i === index ? { ...m, ...patch } : m)) },
    );
  }
  return (
    <section className="ai-settings">
      <div className="ai-settings-header">
        <h2>{t('Proveedores IA')}</h2>
        {value && (
          <div className="form-actions">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('Recargar configuración')}
              tooltip={t('Recargar configuración guardada')}
              disabled={busy || reprocessing}
              onClick={() => void run(load)}
            >
              <RefreshCw aria-hidden="true" className={busy ? 'animate-spin' : undefined} />
            </Button>
            <Button
              type="submit"
              form="ai-settings-form"
              disabled={
                busy ||
                reprocessing ||
                value.models.some((m) => !m.model || !m.provider) ||
                (['gemini', 'provider'].includes(value.embeddings?.mode || '') &&
                  !value.embeddings?.model)
              }
              size="icon"
              tooltip={t('Guardar configuración IA')}
            >
              <Save />
            </Button>
          </div>
        )}
      </div>
      <p>
        {t(
          'Configura conexiones y modelos. El modelo predeterminado se aplica a los perfiles sin selección propia. Los modelos alternativos se autorizan en cada perfil.',
        )}
      </p>
      {value && (
        <form
          id="ai-settings-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const invalid = event.currentTarget.querySelector<HTMLInputElement | HTMLSelectElement>(
              'input:invalid,select:invalid',
            );
            if (invalid) {
              const card = invalid.closest<HTMLElement>('[data-ai-editor]');
              if (card) {
                setTab('conversation');
                if (card.dataset.aiEditor === 'connection')
                  setConnectionEditor(card.dataset.editorId!);
                else setModelEditor(card.dataset.editorId!);
              }
              requestAnimationFrame(() => invalid.reportValidity());
              return;
            }
            void run(async () => {
              await api('/v1/admin/ai', 'PUT', {
                revision: value.revision,
                defaultModel: value.defaultModel,
                models: value.models,
                reranking: value.reranking || { enabled: false, provider: '', model: '' },
                ...(value.embeddings
                  ? {
                      embeddings: (({
                        hasApiKey: _hasApiKey,
                        secretHint: _secretHint,
                        ...settings
                      }) => settings)(value.embeddings),
                    }
                  : {}),
                providers: value.providers.map(
                  ({ hasApiKey: _hasApiKey, secretHint: _secretHint, ...p }) => p,
                ),
              });
              await load();
              setNotice(t('Configuración IA guardada.'));
            });
          }}
        >
          <fieldset disabled={busy || reprocessing}>
            <Tabs value={tab} onValueChange={setTab} className="provider-settings">
              <div className="ai-settings-toolbar">
                <TabsList aria-label={t('Tipo de IA')} className="provider-tabs-list">
                  <TabsTrigger value="conversation">
                    <MessagesSquare aria-hidden="true" />
                    {t('Conversación')}
                  </TabsTrigger>
                  <TabsTrigger value="embeddings">
                    <Brain aria-hidden="true" />
                    {t('Embeddings de memoria')}
                  </TabsTrigger>
                  <TabsTrigger value="reranking">
                    <ListOrdered aria-hidden="true" />
                    Reranking
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="conversation">
                <div className="ai-section-heading">
                  <h3>{t('Conexiones')}</h3>
                  <div className="ai-heading-actions">
                    <span>
                      {
                        value.providers.filter(
                          (provider) => !provider.scope || provider.scope === 'conversation',
                        ).length
                      }{' '}
                      {t('conexiones')}
                    </span>
                    <Button
                      type="button"
                      disabled={value.providers.length >= 30}
                      onClick={() => {
                        const id = 'connection-' + crypto.randomUUID();
                        setConnectionEditor(id);
                        setValue({
                          ...value,
                          providers: [
                            ...value.providers,
                            {
                              id,
                              name: '',
                              kind: 'openai',
                              baseUrl: '',
                              apiKey: '',
                            },
                          ],
                        });
                      }}
                      size="icon"
                      tooltip={t('Añadir conexión')}
                    >
                      <Plus />
                    </Button>
                  </div>
                </div>
                <p>{t('Añade las cuentas que usarán tus modelos.')}</p>
                {value.providers.map((p, i) =>
                  p.scope && p.scope !== 'conversation' ? null : (
                    <AIEditorCard
                      key={p.id}
                      id={p.id}
                      kind="connection"
                      title={p.name || t(kinds[p.kind as keyof typeof kinds])}
                      detail={
                        p.baseUrl || (p.name ? t(kinds[p.kind as keyof typeof kinds]) : undefined)
                      }
                      status={
                        savedProviders.some(
                          (saved) =>
                            saved.id === p.id && JSON.stringify(saved) === JSON.stringify(p),
                        )
                          ? t('Guardada')
                          : t('Sin guardar')
                      }
                      actions={
                        <>
                          <Button
                            type="button"
                            size="icon"
                            tooltip={
                              savedProviders.some((saved) => saved.id === p.id)
                                ? savedProviders.some(
                                    (saved) =>
                                      saved.id === p.id &&
                                      JSON.stringify(saved) === JSON.stringify(p),
                                  )
                                  ? t('Eliminar conexión')
                                  : t('Descartar cambios')
                                : t('Cancelar conexión')
                            }
                            variant="ghost"
                            onClick={() => {
                              const saved = savedProviders.find((item) => item.id === p.id);
                              if (saved && JSON.stringify(saved) !== JSON.stringify(p)) {
                                setValue({
                                  ...value,
                                  providers: value.providers.map((item, n) =>
                                    n === i ? saved : item,
                                  ),
                                  models: value.models.map((item) =>
                                    item.provider === p.id
                                      ? savedModels.find(
                                          (original) =>
                                            original.id === item.id && original.provider === p.id,
                                        ) || item
                                      : item,
                                  ),
                                });
                              } else {
                                setValue({
                                  ...value,
                                  providers: value.providers.filter((_, n) => n !== i),
                                });
                              }
                            }}
                          >
                            {savedProviders.some(
                              (saved) =>
                                saved.id === p.id && JSON.stringify(saved) === JSON.stringify(p),
                            ) ? (
                              <Trash2 />
                            ) : (
                              <X />
                            )}
                          </Button>
                        </>
                      }
                      open={connectionEditor === p.id}
                      onOpenChange={(open) => setConnectionEditor(open ? p.id : '')}
                    >
                      <div className="ai-provider-selector">
                        <SelectField
                          id={'ai-kind-' + i}
                          label={t('Proveedor')}
                          value={p.kind}
                          onChange={(e) =>
                            provider(i, {
                              kind: e.target.value,
                              name: '',
                              baseUrl: '',
                              apiKey: '',
                              hasApiKey: false,
                              secretHint: undefined,
                              clearApiKey: false,
                            })
                          }
                        >
                          {p.kind === 'codex' && !value.codexAvailable && (
                            <option value="codex" disabled>
                              {t('Codex CLI (no disponible)')}
                            </option>
                          )}
                          {Object.entries(kinds)
                            .filter(([id]) => id !== 'codex' || value.codexAvailable)
                            .map(([id, label]) => (
                              <option key={id} value={id}>
                                {t(label)}
                              </option>
                            ))}
                        </SelectField>
                      </div>
                      {p.kind === 'home_assistant' && (
                        <p>
                          {t(
                            'Reutiliza la conexión de Home Assistant habilitada en cada perfil. No requiere otra API key. Selecciona una entidad AI Task de tu integración IA o usa la preferida de Home Assistant.',
                          )}
                        </p>
                      )}
                      {!['codex', 'home_assistant'].includes(p.kind) && (
                        <>
                          <Field
                            id={'ai-url-' + i}
                            label={t('URL base (incluye /v1; vacía para usar la oficial)')}
                            type="url"
                            value={p.baseUrl}
                            required={p.kind === 'compatible'}
                            placeholder={
                              p.kind === 'ollama'
                                ? 'http://localhost:11434/v1'
                                : 'https://api.example.com/v1'
                            }
                            onChange={(e) => provider(i, { baseUrl: e.target.value })}
                          />
                          <SecretEditor
                            id={'ai-key-' + i}
                            value={p.apiKey}
                            configured={p.hasApiKey}
                            hint={p.secretHint}
                            onChange={(value) => provider(i, { apiKey: value })}
                            deleteAction={
                              p.hasApiKey ? (
                                <DeleteAIKey
                                  disabled={
                                    !p.hasApiKey ||
                                    busy ||
                                    reprocessing ||
                                    JSON.stringify(value) !== savedSettings
                                  }
                                  description={t(
                                    'La clave se borrará inmediatamente de esta conexión. Los modelos que la usan necesitarán una nueva clave.',
                                  )}
                                  onConfirm={() =>
                                    void run(async () => {
                                      await api('/v1/admin/ai/api-key', 'DELETE', {
                                        revision: value.revision,
                                        provider: p.id,
                                      });
                                      await load();
                                      setNotice(t('API key borrada.'));
                                    })
                                  }
                                />
                              ) : undefined
                            }
                          />
                        </>
                      )}
                    </AIEditorCard>
                  ),
                )}
                <div className="ai-section-heading">
                  <h3 className="ai-heading-label">
                    <Cpu aria-hidden="true" />
                    {t('Modelos')}
                  </h3>
                  <div className="ai-heading-actions">
                    <span>
                      {value.models.length} {t('configurados')}
                    </span>
                    <Button
                      type="button"
                      disabled={value.models.length >= 100}
                      onClick={() => {
                        const id = 'model-' + crypto.randomUUID();
                        setModelEditor(id);
                        setValue({
                          ...value,
                          models: [
                            ...value.models,
                            {
                              id,
                              label: '',
                              provider: '',
                              model: '',
                            },
                          ],
                        });
                      }}
                      size="icon"
                      tooltip={t('Añadir modelo')}
                    >
                      <Plus />
                    </Button>
                  </div>
                </div>
                <p>
                  {t(
                    'Elige una conexión, selecciona un modelo y ajusta su esfuerzo de razonamiento.',
                  )}
                </p>
                {value.models.map((m, i) => (
                  <AIEditorCard
                    key={m.id}
                    id={m.id}
                    kind="model"
                    title={m.label || m.model || t('Nuevo modelo')}
                    detail={
                      value.providers.find((provider) => provider.id === m.provider)?.name ||
                      t(
                        kinds[
                          value.providers.find((provider) => provider.id === m.provider)
                            ?.kind as keyof typeof kinds
                        ],
                      )
                    }
                    status={
                      m.id === value.defaultModel
                        ? t('Predeterminado')
                        : savedModels.some(
                              (saved) =>
                                saved.id === m.id && JSON.stringify(saved) === JSON.stringify(m),
                            )
                          ? t('Guardado')
                          : t('Sin guardar')
                    }
                    actions={
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          className="danger"
                          onClick={() =>
                            setValue({ ...value, models: value.models.filter((_, n) => n !== i) })
                          }
                          size="icon"
                          tooltip={t('Eliminar modelo')}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    }
                    open={modelEditor === m.id}
                    onOpenChange={(open) => setModelEditor(open ? m.id : '')}
                  >
                    <SelectField
                      id={'ai-model-provider-' + i}
                      label={t('Conexión')}
                      value={m.provider}
                      required
                      onChange={(e) =>
                        model(i, {
                          provider: e.target.value,
                          model: '',
                          label: '',
                          effort: undefined,
                        })
                      }
                    >
                      <option value="">{t('Selecciona una conexión')}</option>
                      {value.providers
                        .filter(
                          (p) =>
                            (!p.scope || p.scope === 'conversation') &&
                            (p.kind !== 'codex' || value.codexAvailable),
                        )
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name || t(kinds[p.kind as keyof typeof kinds])}
                          </option>
                        ))}
                    </SelectField>
                    <div className="ai-model-options">
                      <ProviderModels
                        key={JSON.stringify(value.providers.find((p) => p.id === m.provider))}
                        id={'ai-model-remote-' + i}
                        provider={value.providers.find((p) => p.id === m.provider)}
                        value={m.model}
                        onSelect={(item) =>
                          model(i, {
                            model: item.id,
                            label: item.name.slice(0, 100),
                          })
                        }
                      />
                      {['codex', 'openai', 'openrouter', 'compatible', 'ollama'].includes(
                        value.providers.find((p) => p.id === m.provider)?.kind || '',
                      ) && (
                        <div className="ai-effort">
                          <SelectField
                            id={'ai-model-effort-' + i}
                            label={t('Esfuerzo de razonamiento')}
                            value={m.effort || ''}
                            onChange={(e) =>
                              model(i, {
                                effort: (e.target.value || undefined) as AIModel['effort'],
                              })
                            }
                          >
                            <option value="">{t('Predeterminado del proveedor')}</option>
                            <option value="low">{t('Bajo · más rápido')}</option>
                            <option value="medium">{t('Medio · equilibrado')}</option>
                            <option value="high">{t('Alto')}</option>
                            <option value="xhigh">{t('Muy alto')}</option>
                            <option value="max">{t('Máximo')}</option>
                          </SelectField>
                        </div>
                      )}
                    </div>
                  </AIEditorCard>
                ))}

                <SelectField
                  id="ai-default"
                  label={t('Modelo predeterminado')}
                  value={value.defaultModel}
                  required
                  onChange={(e) => setValue({ ...value, defaultModel: e.target.value })}
                >
                  <option value="">{t('Selecciona un modelo')}</option>
                  {value.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </SelectField>
                <p>
                  {t(
                    'Codex CLI conserva su autenticación y configuración actuales. Las API externas usan sus propias capacidades; búsqueda web e imágenes generadas de Codex no están disponibles en ellas. Usa modelos que admitan herramientas y, si corresponde, imágenes y salida JSON estructurada.',
                  )}
                </p>
              </TabsContent>
              <TabsContent value="reranking">
                <h3>{t('Relevancia de recuerdos')}</h3>
                <p>
                  {t(
                    'Ordena hasta 20 recuerdos del mismo perfil. Puedes reutilizar cualquier conexión compatible o crear una exclusiva de reranking, sin añadir modelos a Conversación.',
                  )}
                </p>
                <SelectField
                  id="reranking-mode"
                  label="Reranking"
                  value={value.reranking?.enabled ? value.reranking.api || 'model' : 'disabled'}
                  onChange={(event) =>
                    setValue(
                      (current) =>
                        current && {
                          ...current,
                          reranking: {
                            provider: '',
                            model: '',
                            ...current.reranking,
                            enabled: event.target.value !== 'disabled',
                            api:
                              event.target.value === 'disabled'
                                ? current.reranking?.api || 'model'
                                : event.target.value === 'rerank'
                                  ? 'rerank'
                                  : 'model',
                            ...(event.target.value !== 'disabled' &&
                            event.target.value !== (current.reranking?.api || 'model')
                              ? { model: '' }
                              : {}),
                          },
                        },
                    )
                  }
                >
                  <option value="disabled">{t('Desactivar reranking (orden de búsqueda)')}</option>
                  <option value="model">{t('Modelo de IA (respuesta estructurada)')}</option>
                  <option value="rerank">{t('API rerank (Cohere, Jina o compatible)')}</option>
                </SelectField>
                {value.reranking?.enabled && (
                  <>
                    <MemoryConnection
                      onRemove={removeMemoryProvider}
                      scope="reranking"
                      providers={value.providers}
                      selected={value.reranking.provider}
                      allowed={[
                        'openai',
                        'openrouter',
                        'compatible',
                        'ollama',
                        'anthropic',
                        ...(value.codexAvailable ? ['codex'] : []),
                      ]}
                      onProviders={(providers) =>
                        setValue((current) => current && { ...current, providers })
                      }
                      onSelect={(provider) =>
                        setValue(
                          (current) =>
                            current && {
                              ...current,
                              reranking: { ...current.reranking!, provider, model: '' },
                            },
                        )
                      }
                    />
                    <div className="ai-model-options">
                      {value.reranking.api === 'rerank' ? (
                        <Field
                          id="reranking-model"
                          label={t('Modelo de reranking')}
                          required
                          maxLength={200}
                          value={value.reranking.model}
                          onChange={(event) =>
                            setValue(
                              (current) =>
                                current && {
                                  ...current,
                                  reranking: { ...current.reranking!, model: event.target.value },
                                },
                            )
                          }
                        />
                      ) : (
                        <ProviderModels
                          id="reranking-model"
                          provider={value.providers.find(
                            (provider) => provider.id === value.reranking?.provider,
                          )}
                          value={value.reranking.model}
                          onSelect={(model) =>
                            setValue(
                              (current) =>
                                current && {
                                  ...current,
                                  reranking: { ...current.reranking!, model: model.id },
                                },
                            )
                          }
                        />
                      )}
                      {value.reranking.api !== 'rerank' &&
                        ['codex', 'openai', 'openrouter', 'compatible', 'ollama'].includes(
                          value.providers.find(
                            (provider) => provider.id === value.reranking?.provider,
                          )?.kind || '',
                        ) && (
                          <SelectField
                            id="reranking-effort"
                            label={t('Esfuerzo de razonamiento')}
                            value={value.reranking.effort || ''}
                            onChange={(event) =>
                              setValue(
                                (current) =>
                                  current && {
                                    ...current,
                                    reranking: {
                                      ...current.reranking!,
                                      effort: (event.target.value ||
                                        undefined) as AIModel['effort'],
                                    },
                                  },
                              )
                            }
                          >
                            <option value="">{t('Predeterminado del proveedor')}</option>
                            <option value="low">{t('Bajo · más rápido')}</option>
                            <option value="medium">{t('Medio · equilibrado')}</option>
                            <option value="high">{t('Alto')}</option>
                            <option value="xhigh">{t('Muy alto')}</option>
                            <option value="max">{t('Máximo')}</option>
                          </SelectField>
                        )}
                    </div>
                    <div className="form-actions">
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        tooltip={t('Probar reranking con textos de ejemplo')}
                        disabled={busy || JSON.stringify(value) !== savedSettings}
                        onClick={() =>
                          void run(async () => {
                            await api('/v1/admin/ai/reranking/test', 'POST', {
                              revision: value.revision,
                            });
                            setNotice(t('Conexión y modelo de reranking compatibles.'));
                          })
                        }
                      >
                        <FlaskConical />
                      </Button>
                      <small>{t('Guarda antes de probar. La prueba no envía recuerdos.')}</small>
                    </div>
                    <p>
                      {t(
                        'La API rerank utiliza la URL base de la conexión más /rerank (por ejemplo, https://api.cohere.com/v2 o https://api.jina.ai/v1). Si falla, la búsqueda conserva el orden híbrido sin reintentar.',
                      )}
                    </p>
                  </>
                )}
              </TabsContent>
              <TabsContent value="embeddings">
                <h3>{t('Embeddings de memoria')}</h3>
                <p>
                  {t(
                    'La memoria avanzada usa el proveedor de embeddings seleccionado para guardar y buscar recuerdos. Los modos simple y sin memoria no consultan embeddings.',
                  )}
                </p>
                {value.embeddings ? (
                  <EmbeddingEditor
                    value={value.embeddings}
                    providers={value.providers}
                    onProviders={(providers) =>
                      setValue((current) => current && { ...current, providers })
                    }
                    onRemoveProvider={removeMemoryProvider}
                    deleteKey={
                      <DeleteAIKey
                        disabled={
                          !value.embeddings.hasApiKey ||
                          busy ||
                          reprocessing ||
                          JSON.stringify(value) !== savedSettings
                        }
                        description={t(
                          'Se eliminará la clave de embeddings guardada en Zero y se desactivarán los embeddings. Los recuerdos seguirán disponibles por palabras. Si la clave procede del servidor, Zero dejará de usarla; el archivo del servidor no se modifica.',
                        )}
                        onConfirm={() =>
                          void run(async () => {
                            await api('/v1/admin/ai/api-key', 'DELETE', {
                              revision: value.revision,
                            });
                            await load();
                            setNotice(
                              t('API key retirada de embeddings. Búsqueda por palabras activada.'),
                            );
                          })
                        }
                      />
                    }
                    dimensions={value.embeddingInfo?.dimensions}
                    onChange={(embeddings) =>
                      setValue((current) => current && { ...current, embeddings })
                    }
                  />
                ) : (
                  <p role="status">{t('Configuración de embeddings no disponible.')}</p>
                )}
                <div className="ai-embedding-maintenance">
                  <div>
                    <strong>{t('Recuerdos existentes')}</strong>
                    <p>
                      {t(
                        'Al cambiar de modelo, los recuerdos anteriores se buscan por palabras hasta reprocesarlos. El texto y los perfiles se conservan.',
                      )}
                    </p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        tooltip={t('Reprocesar todos los recuerdos')}
                        disabled={
                          reprocessing ||
                          value.embeddings?.mode === 'disabled' ||
                          JSON.stringify(value) !== savedSettings
                        }
                      >
                        <DatabaseZap />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('¿Reprocesar todos los recuerdos?')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t(
                            'Se enviará el texto de los recuerdos de todos los perfiles al proveedor guardado para generar nuevos vectores. Puede tener coste. Mantén esta página abierta hasta terminar.',
                          )}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => {
                            setReprocessing(true);
                            void run(async () => {
                              let after = '0';
                              let count = 0;
                              setProgress(t('Reprocesando recuerdos…'));
                              try {
                                while (true) {
                                  const result = await api<{
                                    processed: number;
                                    after: string;
                                    done: boolean;
                                  }>('/v1/admin/ai/embeddings/reprocess', 'POST', {
                                    revision: value.revision,
                                    after,
                                  });
                                  count += result.processed;
                                  setProgress(t('{count} recuerdos reprocesados.', { count }));
                                  after = result.after;
                                  if (result.done) break;
                                }
                                setNotice(t('Recuerdos reprocesados.'));
                              } catch (error) {
                                setProgress(
                                  t(
                                    'Reprocesado detenido tras {count} recuerdos confirmados. No se ha reintentado.',
                                    { count },
                                  ),
                                );
                                throw error;
                              } finally {
                                setReprocessing(false);
                              }
                            });
                          }}
                        >
                          {t('Reprocesar recuerdos')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  {JSON.stringify(value) !== savedSettings && (
                    <p>{t('Guarda la configuración antes de reprocesar.')}</p>
                  )}
                  {progress && <p role="status">{progress}</p>}
                </div>
              </TabsContent>
            </Tabs>
          </fieldset>
        </form>
      )}
    </section>
  );
}
export function ProfileModels({
  profile,
}: {
  profile?: { defaultModel?: string; alternateModels?: string[] } | null;
}) {
  const t = useTranslations();
  const [models, setModels] = useState<AIModel[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    api<AISettings>('/v1/admin/ai')
      .then((v) => setModels(v.models))
      .catch((e) => {
        setError(e.message);
        notifyError(e);
      });
  }, []);
  if (!models)
    return <p role="status">{error ? t('Modelos no disponibles.') : t('Cargando modelos…')}</p>;
  const missing = [
    ...new Set(
      [profile?.defaultModel, ...(profile?.alternateModels || [])].filter(
        (id): id is string => !!id && !models.some((m) => m.id === id),
      ),
    ),
  ];
  return (
    <>
      <h3 className="settings-heading">{t('Modelos IA')}</h3>
      <SelectField
        id="profile-default-model"
        name="defaultModel"
        label={t('Modelo predeterminado de este perfil')}
        defaultValue={profile?.defaultModel || ''}
      >
        <option value="">{t('Usar predeterminado global')}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {missing.map((id) => (
          <option key={id} value={id} disabled>
            {t('Modelo no disponible')}
          </option>
        ))}
      </SelectField>
      <p>
        {t(
          'Modelos alternativos permitidos para /model. La selección del usuario solo se aplica a la siguiente pregunta.',
        )}
      </p>
      {models.map((m) => (
        <CheckField
          key={m.id}
          id={'profile-alt-' + m.id}
          name="alternateModels"
          value={m.id}
          label={m.label}
          defaultChecked={profile?.alternateModels?.includes(m.id)}
        />
      ))}
      {missing.length > 0 && (
        <p role="status">
          {t(
            'Hay modelos eliminados en este perfil. Selecciona modelos disponibles antes de guardar.',
          )}
        </p>
      )}
      <input type="hidden" name="modelsLoaded" value="true" />
    </>
  );
}
function ProviderModels({
  id,
  provider,
  value,
  onSelect,
  embeddings,
  actions,
}: {
  actions?: ReactNode;
  id: string;
  embeddings?: EmbeddingSettings;
  reranking?: {
    enabled: boolean;
    provider: string;
    model: string;
    api?: 'model' | 'rerank';
    effort?: AIModel['effort'];
  };
  provider?: Provider;
  value: string;
  onSelect: (item: { id: string; name: string }) => void;
}) {
  const t = useTranslations();
  const [page, setPage] = useState<{ items: { id: string; name: string }[]; total: number }>();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!provider) return;
    let active = true;
    setBusy(true);
    setError('');
    const timer = setTimeout(() => {
      const { hasApiKey: _hasApiKey, secretHint: _secretHint, ...connection } = provider;
      api<{ items: { id: string; name: string }[]; total: number }>(
        embeddings ? '/v1/admin/ai/embeddings/models' : '/v1/admin/ai/models',
        'POST',
        {
          ...(embeddings
            ? {
                embeddings: (({ hasApiKey: _hasApiKey, secretHint: _secretHint, ...settings }) =>
                  settings)(embeddings),
                ...(embeddings.mode === 'provider' ? { connection } : {}),
              }
            : { provider: connection }),
          search,
          offset,
          limit: 20,
        },
      )
        .then((result) => {
          if (active) setPage(result);
        })
        .catch((e) => {
          if (active) {
            setError(e.message);
            notifyError(e);
            setPage(undefined);
          }
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [provider, embeddings, search, offset, reload]);
  const items = page?.items || [];
  return (
    <div className="ai-model-discovery">
      <div className="settings-field ai-model-selector">
        <Label htmlFor={id}>{t('Modelo del proveedor')}</Label>
        <div className="ai-model-selector-controls">
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
              <Button
                id={id}
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={open}
                aria-controls={id + '-options'}
                disabled={!provider}
                className="ai-model-trigger"
              >
                <span>
                  {items.find((item) => item.id === value)?.name ||
                    (value === 'preferred' ? t('IA preferida de Home Assistant') : value) ||
                    (!provider ? t('Selecciona una conexión') : t('Selecciona un modelo'))}
                </span>
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="start"
                sideOffset={4}
                className="ai-model-popover"
                aria-label={t('Modelos del proveedor')}
              >
                <Input
                  aria-label={t('Buscar en modelos del proveedor')}
                  placeholder={t('Buscar modelo…')}
                  value={search}
                  maxLength={200}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setOffset(0);
                  }}
                />
                <div
                  id={id + '-options'}
                  role="listbox"
                  aria-label={t('Modelo del proveedor')}
                  aria-busy={busy}
                  onKeyDown={(event) => {
                    const options = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
                    );
                    const index = options.indexOf(document.activeElement as HTMLButtonElement);
                    const next =
                      event.key === 'ArrowDown'
                        ? Math.min(index + 1, options.length - 1)
                        : event.key === 'ArrowUp'
                          ? Math.max(index - 1, 0)
                          : event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? options.length - 1
                              : undefined;
                    if (next !== undefined) {
                      event.preventDefault();
                      options[next]?.focus();
                    }
                  }}
                >
                  {provider?.kind === 'home_assistant' &&
                    t('ia preferida de home assistant').includes(search.toLowerCase()) && (
                      <button
                        type="button"
                        role="option"
                        aria-selected={value === 'preferred'}
                        onClick={() => {
                          onSelect({ id: 'preferred', name: 'IA preferida de Home Assistant' });
                          setOpen(false);
                        }}
                      >
                        {t('IA preferida de Home Assistant')}
                      </button>
                    )}
                  {!busy &&
                    items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={value === item.id}
                        onClick={() => {
                          onSelect(item);
                          setOpen(false);
                        }}
                      >
                        {item.name}
                      </button>
                    ))}
                </div>
                {busy && <p role="status">{t('Consultando modelos del proveedor…')}</p>}
                {!busy && page && !items.length && (
                  <p role="status">
                    {provider?.kind === 'home_assistant' && !search
                      ? t(
                          'Home Assistant no publica entidades AI Task disponibles. Si ya existe la subentrada, comprueba que tenga una entidad habilitada y que la integración esté cargada; después actualiza los modelos.',
                        )
                      : t('No se encontraron modelos disponibles.')}
                  </p>
                )}
                <div className="form-actions ai-catalog-actions">
                  <Button
                    type="button"
                    variant="outline"
                    hidden={!page || page.total <= 20}
                    disabled={busy || offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 20))}
                    size="icon"
                    tooltip={t('Anterior')}
                  >
                    <ArrowLeft />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    hidden={!page || page.total <= 20}
                    disabled={busy || !page || offset + 20 >= page.total}
                    onClick={() => setOffset(offset + 20)}
                    size="icon"
                    tooltip={t('Siguiente')}
                  >
                    <ArrowRight />
                  </Button>
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <Button
            type="button"
            variant="outline"
            disabled={!provider || busy}
            onClick={() => setReload((n) => n + 1)}
            size="icon"
            tooltip={t('Actualizar modelos')}
          >
            <RefreshCw />
          </Button>
          {actions}
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function DeleteAIKey({
  disabled,
  description,
  onConfirm,
}: {
  disabled: boolean;
  description: string;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          size="icon"
          tooltip={t('Borrar API key guardada')}
          disabled={disabled}
        >
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('¿Borrar API key guardada?')}</AlertDialogTitle>
          <AlertDialogDescription>
            {description} {t('Guarda los cambios pendientes antes de borrar la clave.')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {t('Borrar API key')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MemoryConnection({
  scope,
  providers,
  selected,
  allowed,
  onProviders,
  onSelect,
  onRemove,
}: {
  scope: 'embeddings' | 'reranking';
  providers: Provider[];
  selected: string;
  allowed: string[];
  onProviders: (providers: Provider[]) => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations();
  const connection = providers.find((provider) => provider.id === selected);
  const change = (patch: Partial<Provider>) =>
    onProviders(
      providers.map((provider) =>
        provider.id === selected ? { ...provider, ...patch } : provider,
      ),
    );
  const title = scope === 'embeddings' ? 'embeddings' : 'reranking';
  return (
    <div className="ai-settings-entry">
      <div className="ai-connection-selector">
        <SelectField
          id={scope + '-connection'}
          label={t('Conexión de ') + title}
          value={selected}
          required
          onChange={(event) => {
            if (event.target.value === '__new__') {
              const provider: Provider = {
                id: scope + '-' + crypto.randomUUID(),
                scope,
                kind: scope === 'reranking' ? 'compatible' : 'openai',
                name: '',
                baseUrl: '',
                apiKey: '',
              };
              onProviders([...providers, provider]);
              onSelect(provider.id);
            } else onSelect(event.target.value);
          }}
        >
          <option value="">{t('Selecciona una conexión')}</option>
          {providers
            .filter((provider) => allowed.includes(provider.kind))
            .map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name || t(kinds[provider.kind as keyof typeof kinds])}
                {provider.scope ? ' · ' + provider.scope : t(' · conversación')}
              </option>
            ))}
          <option value="__new__" disabled={providers.length >= 30}>
            {t('Nueva conexión exclusiva de')} {title}
          </option>
        </SelectField>
        {connection?.scope === scope && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="danger"
                tooltip={t('Eliminar conexión exclusiva')}
              >
                <Trash2 />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('¿Eliminar esta conexión?')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    'Al guardar se borrará la conexión y su clave. Si se reutiliza en embeddings o reranking, esas funciones se desactivarán. Los recuerdos existentes se conservan.',
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => onRemove(connection.id)}>
                  {t('Eliminar conexión')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      {connection?.scope === scope ? (
        <>
          <SelectField
            id={scope + '-kind'}
            label={t('Proveedor')}
            value={connection.kind}
            onChange={(event) => {
              change({
                kind: event.target.value,
                baseUrl: '',
                apiKey: '',
                hasApiKey: false,
                secretHint: undefined,
              });
              onSelect(selected);
            }}
          >
            {allowed.map((kind) => (
              <option key={kind} value={kind}>
                {t(kinds[kind as keyof typeof kinds])}
              </option>
            ))}
          </SelectField>
          <Field
            id={scope + '-name'}
            label={t('Nombre de la conexión (opcional)')}
            value={connection.name}
            maxLength={100}
            onChange={(event) => change({ name: event.target.value })}
          />
          {connection.kind !== 'codex' && (
            <>
              <Field
                id={scope + '-url'}
                label={t('URL base (vacía para usar la oficial)')}
                type="url"
                value={connection.baseUrl}
                required={connection.kind === 'compatible'}
                onChange={(event) =>
                  change({ baseUrl: event.target.value, hasApiKey: false, secretHint: undefined })
                }
              />
              <SecretEditor
                id={scope + '-key'}
                value={connection.apiKey}
                configured={connection.hasApiKey}
                hint={connection.secretHint}
                onChange={(apiKey) => change({ apiKey })}
              />
            </>
          )}

          <p>
            {t(
              'Esta conexión se guarda de forma independiente y no aparece en Conversación. También puede reutilizarse desde otra función compatible.',
            )}
          </p>
        </>
      ) : (
        connection && (
          <p>
            {t(
              'Reutiliza esta conexión sin crear un modelo de conversación. Sus credenciales se gestionan en',
            )}{' '}
            {connection.scope === 'embeddings'
              ? t('Embeddings de memoria')
              : connection.scope === 'reranking'
                ? 'Reranking'
                : t('Conversación')}
            .
          </p>
        )
      )}
    </div>
  );
}

function EmbeddingEditor({
  value,
  dimensions,
  deleteKey,
  providers,
  onProviders,
  onRemoveProvider,
  onChange,
}: {
  value: EmbeddingSettings;
  providers: Provider[];
  onProviders: (providers: Provider[]) => void;
  onRemoveProvider: (id: string) => void;
  dimensions?: number;
  deleteKey: ReactNode;
  onChange: (settings: EmbeddingSettings) => void;
}) {
  const t = useTranslations();
  // Keep discovery inputs stable when unrelated model labels or default selections change.
  const discovery = JSON.stringify(value);
  const connection = JSON.stringify(
    value.mode === 'provider'
      ? providers.find((p) => p.id === value.provider) || null
      : { id: 'embeddings', name: 'Gemini', kind: 'gemini', baseUrl: '', apiKey: value.apiKey },
  );
  const [inputs, setInputs] = useState(() => ({
    embeddings: value,
    provider: JSON.parse(connection) as Provider | null,
  }));
  useEffect(() => {
    setInputs({
      embeddings: JSON.parse(discovery) as EmbeddingSettings,
      provider: JSON.parse(connection) as Provider | null,
    });
  }, [discovery, connection]);
  return (
    <>
      <SelectField
        id="ai-embedding-mode"
        label="Embeddings"
        value={value.mode}
        onChange={(e) =>
          onChange({
            mode: e.target.value as EmbeddingSettings['mode'],
            model: '',
            baseUrl: '',
            apiKey: '',
          })
        }
      >
        <option value="gemini">{t('Configurar Gemini')}</option>
        <option value="provider">
          {t('Usar conexión OpenAI, OpenRouter, Ollama o compatible')}
        </option>
        <option value="disabled">{t('Desactivar embeddings (búsqueda por palabras)')}</option>
      </SelectField>
      {value.mode === 'gemini' && (
        <>
          <SecretEditor
            id="ai-embedding-key"
            label={t('API key de Gemini')}
            value={value.apiKey}
            configured={value.hasApiKey}
            hint={value.secretHint}
            onChange={(apiKey) => onChange({ ...value, apiKey })}
            deleteAction={value.hasApiKey ? deleteKey : undefined}
          />
        </>
      )}
      {value.mode === 'provider' && (
        <>
          <MemoryConnection
            onRemove={onRemoveProvider}
            scope="embeddings"
            providers={providers}
            selected={value.provider || ''}
            allowed={['openai', 'openrouter', 'ollama', 'compatible']}
            onProviders={onProviders}
            onSelect={(provider) =>
              onChange({
                ...value,
                provider: provider || undefined,
                model: '',
                dimensions: undefined,
              })
            }
          />
          {inputs.provider?.kind === 'compatible' && (
            <p>
              {t(
                'El servidor compatible puede listar modelos sin indicar sus capacidades. Usa la prueba para confirmar que el modelo admite embeddings.',
              )}
            </p>
          )}
          <Field
            id="ai-embedding-dimensions"
            label={t('Dimensiones de salida (opcional; solo si el modelo lo admite)')}
            type="number"
            min={1}
            max={dimensions || 4000}
            value={value.dimensions ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                dimensions: e.target.value ? Number(e.target.value) : undefined,
              })
            }
          />
        </>
      )}
      {['gemini', 'provider'].includes(value.mode) && (
        <>
          <ProviderModels
            actions={
              <EmbeddingTest
                key={discovery + connection}
                settings={value}
                connection={value.mode === 'provider' ? inputs.provider || undefined : undefined}
              />
            }
            id="ai-embedding-model"
            provider={inputs.provider || undefined}
            embeddings={inputs.embeddings}
            value={value.model}
            onSelect={(item) => onChange({ ...value, model: item.id })}
          />
        </>
      )}
      <p>
        {t('La base de datos conserva')} {dimensions ?? 'las'}{' '}
        {t(
          'dimensiones configuradas. Al cambiar de modelo, los vectores anteriores se conservan y siguen disponibles por palabras; la búsqueda semántica solo compara vectores del mismo modelo. Puedes reprocesarlos con el modelo guardado desde «Recuerdos existentes».',
        )}
      </p>
    </>
  );
}

function EmbeddingTest({
  settings,
  connection,
}: {
  settings: EmbeddingSettings;
  connection?: Provider;
}) {
  const t = useTranslations();
  const { busy, run, setNotice } = useAdminTask();
  return (
    <Button
      type="button"
      variant="outline"
      disabled={busy || !settings.model || (settings.mode === 'provider' && !connection)}
      onClick={() =>
        void run(async () => {
          const { hasApiKey: _hasApiKey, secretHint: _secretHint, ...embeddings } = settings;
          const selected = connection
            ? (({ hasApiKey: _hasApiKey, secretHint: _secretHint, ...p }) => p)(connection)
            : undefined;
          const result = await api<{ dimensions: number }>('/v1/admin/ai/embeddings/test', 'POST', {
            embeddings,
            ...(selected ? { connection: selected } : {}),
          });
          setNotice(
            t('Embeddings verificados: vector compatible con ') +
              result.dimensions +
              t(' dimensiones de almacenamiento.'),
          );
        })
      }
      size="icon"
      tooltip={t('Probar embeddings')}
    >
      <FlaskConical />
    </Button>
  );
}
