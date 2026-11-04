'use client';
import { useTranslations } from '../i18n/provider';
import { adminPath } from '../lib/admin-path';
import { Bot, Download, ImagePlus, Save, Send, Sparkles, Upload, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { toast } from 'sonner';
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

interface ImageState {
  image: string | null;
  revision: number;
  telegram: boolean;
  generation: boolean;
}
const endpoint = (id: string) => '/v1/admin/setup/assistants/' + encodeURIComponent(id) + '/image';
const notify = (id: string) =>
  window.dispatchEvent(new CustomEvent('assistant-image-changed', { detail: id }));

export function AssistantAvatar({ id }: { id: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => {
      void api<ImageState>(endpoint(id))
        .then((value) => {
          if (active) setImage(value.image);
        })
        .catch(() => {});
    };
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === id) load();
    };
    load();
    window.addEventListener('assistant-image-changed', changed);
    return () => {
      active = false;
      window.removeEventListener('assistant-image-changed', changed);
    };
  }, [id]);
  return image || id === 'zero' ? (
    <img src={adminPath(image || '/icon.png')} alt="" className="assistant-photo" />
  ) : (
    <Bot size={20} />
  );
}

async function thumbnail(source: string) {
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No se pudo preparar la imagen.');
  context.fillStyle = '#0f172a';
  context.fillRect(0, 0, 256, 256);
  const size = Math.min(image.naturalWidth, image.naturalHeight);
  context.drawImage(
    image,
    (image.naturalWidth - size) / 2,
    (image.naturalHeight - size) / 2,
    size,
    size,
    0,
    0,
    256,
    256,
  );
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function referenceImage(file: File) {
  if (file.size > 5_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('Usa PNG, JPEG o WebP de hasta 5 MB.');
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    for (const edge of [768, 512, 256]) {
      const ratio = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No se pudo preparar la referencia.');
      context.fillStyle = '#0f172a';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const result = canvas.toDataURL('image/jpeg', 0.82);
      if (result.length <= 170000) return result;
    }
    throw new Error('La referencia es demasiado grande. Prueba con otra imagen.');
  } finally {
    URL.revokeObjectURL(source);
  }
}

export function AssistantImageSettings({ id, name }: { id: string; name: string }) {
  const t = useTranslations();
  const { busy, setNotice, run } = useAdminTask();
  const [value, setValue] = useState<ImageState>(),
    [preview, setPreview] = useState<string | null>(null),
    [dirty, setDirty] = useState(false),
    [prompt, setPrompt] = useState(''),
    [generationOpen, setGenerationOpen] = useState(false),
    [references, setReferences] = useState<string[]>([]);
  const referenceInput = useRef<HTMLInputElement>(null);
  const generationTrigger = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const currentId = useRef(id);
  currentId.current = id;
  async function load() {
    const next = await api<ImageState>(endpoint(id));
    setValue(next);
    setPreview(next.image);
    setDirty(false);
  }
  useEffect(() => {
    setPrompt('');
    setReferences([]);
    setGenerationOpen(false);
    void run(load);
  }, [id]);
  async function save(image: string | null) {
    if (!value) return;
    const saved = await api<ImageState>(endpoint(id), 'PUT', { image, revision: value.revision });
    setValue({ ...value, ...saved });
    setPreview(saved.image);
    setDirty(false);
    notify(id);
    setNotice(t('Imagen guardada en Zero. Telegram no se ha modificado.'));
  }
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === id)
        void api<ImageState>(endpoint(id))
          .then((next) => setValue((old) => (old ? { ...old, telegram: next.telegram } : next)))
          .catch(() => {});
    };
    window.addEventListener('assistant-telegram-changed', changed);
    return () => window.removeEventListener('assistant-telegram-changed', changed);
  }, [id]);
  function selectFile(file?: File) {
    if (!file || busy || !value) return;
    void run(async () => {
      if (file.size > 5_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
        throw new Error(t('Usa PNG, JPEG o WebP de hasta 5 MB.'));
      const url = URL.createObjectURL(file);
      try {
        setPreview(await thumbnail(url));
        setDirty(true);
      } finally {
        URL.revokeObjectURL(url);
      }
    });
  }
  function addReferences(files: FileList | File[]) {
    if (busy || !files.length) return;
    const selected = Array.from(files);
    void run(async () => {
      if (references.length + selected.length > 3)
        throw new Error(t('Puedes añadir hasta 3 imágenes de referencia.'));
      const images = await Promise.all(selected.map(referenceImage));
      setReferences((previous) => [...previous, ...images]);
    });
  }
  function generate() {
    if (busy || !value?.generation || !prompt.trim()) return;
    void run(async () => {
      setGenerationOpen(false);
      const loading = toast.loading(t('Generando avatar de {name}…', { name }));
      try {
        const generated = await api<{ image: string }>(endpoint(id) + '/generate', 'POST', {
          prompt: prompt.trim(),
          references,
        });
        const image = await thumbnail(generated.image);
        if (currentId.current === id) {
          setPreview(image);
          setDirty(true);
        }
        toast.success(t('Avatar generado. Guarda la imagen para usarla en Zero.'), {
          id: loading,
          duration: 6000,
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t('No se pudo confirmar la generación. No se ha reintentado.'),
          { id: loading, duration: 8000 },
        );
      }
    });
  }
  return (
    <section className="settings-section assistant-image-settings">
      <div className="avatar-layout">
        <div className="avatar-visual">
          {preview ? (
            <div className="assistant-image-preview avatar-edit">
              <img src={preview} alt={t('Imagen de ') + name} />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon-sm"
                    className="avatar-remove"
                    tooltip={t('Quitar imagen')}
                    disabled={busy}
                  >
                    <X />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('¿Quitar la imagen de')} {name}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('Se eliminará el avatar de Zero. La foto de Telegram se conserva.')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void run(() => save(null))}>
                      {t('Quitar imagen')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ) : (
            <label
              className="image-dropzone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                selectFile(event.dataTransfer.files[0]);
              }}
            >
              <Upload aria-hidden="true" />
              <strong>{t('Arrastra una imagen o selecciona un archivo')}</strong>
              <small>{t('PNG, JPEG o WebP · hasta 5 MB')}</small>
              <Input
                className="sr-only"
                aria-label={t('Subir imagen')}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy || !value}
                onChange={(event) => {
                  selectFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
          )}
        </div>
        <div className="avatar-controls">
          <h3>{t('Imagen del asistente')}</h3>
          <p>{t('PNG, JPEG o WebP. Se recorta al centro.')}</p>
          <div className="avatar-actions">
            {(value?.generation || dirty) && (
              <div className="action-group" role="group" aria-label={t('Imagen de Zero')}>
                {value?.generation && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    tooltip={t('Generar avatar con IA')}
                    ref={generationTrigger}
                    aria-disabled={busy}
                    className={busy ? 'opacity-50' : undefined}
                    onClick={() => {
                      if (!busy) setGenerationOpen(true);
                    }}
                  >
                    <Sparkles />
                  </Button>
                )}
                {dirty && (
                  <Button
                    type="button"
                    disabled={busy || !value || !dirty}
                    onClick={() => void run(() => save(preview))}
                    size="icon"
                    tooltip={t('Guardar imagen en Zero')}
                  >
                    <Save />
                  </Button>
                )}
              </div>
            )}
            {value?.telegram ? (
              <div className="action-group" role="group" aria-label={t('Foto de Telegram')}>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const remote = await api<{ image: string | null }>(
                        endpoint(id) + '/telegram',
                      );
                      if (!remote.image) {
                        setNotice(t('El bot no tiene foto de perfil.'));
                        return;
                      }
                      setPreview(await thumbnail(remote.image));
                      setDirty(true);
                      setNotice(
                        t(
                          'Foto de Telegram importada como vista previa. Guarda para usarla en Zero.',
                        ),
                      );
                    })
                  }
                  size="icon"
                  tooltip={t('Importar foto actual de Telegram')}
                >
                  <Download />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || dirty || !value.image}
                      size="icon"
                      tooltip={t('Actualizar foto de Telegram')}
                    >
                      <Send />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t('¿Actualizar la foto de')} {name} {t('en Telegram?')}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t(
                          'Esto modifica la foto pública del bot conectado. Se publica la imagen guardada en Zero.',
                        )}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                      <AlertDialogAction
                        type="button"
                        onClick={() =>
                          void run(async () => {
                            await api(endpoint(id) + '/telegram', 'POST', {
                              image: value.image,
                              confirm: true,
                            });
                            setNotice(t('Telegram ha confirmado la nueva foto del bot.'));
                          })
                        }
                      >
                        {t('Publicar foto')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <Dialog open={generationOpen} onOpenChange={setGenerationOpen}>
        <DialogContent
          className="avatar-generation-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            generationTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t('Generar avatar de')} {name}
            </DialogTitle>
            <DialogDescription>
              {t('Describe cómo quieres que sea. Puedes añadir imágenes como referencia.')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="avatar-generation-form"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              generate();
            }}
            onPaste={(event) => {
              if (event.clipboardData.files.length) {
                event.preventDefault();
                addReferences(event.clipboardData.files);
              }
            }}
          >
            <div className="avatar-generation-description">
              <label htmlFor={descriptionId}>{t('Descripción del avatar')}</label>
              <Textarea
                id={descriptionId}
                placeholder={t('Por ejemplo, un zorro naranja con gafas y fondo oscuro…')}
                rows={4}
                maxLength={2000}
                value={prompt}
                disabled={busy}
                onChange={(event) => setPrompt(event.target.value)}
                required
              />
            </div>
            <div
              className="avatar-references"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                addReferences(event.dataTransfer.files);
              }}
            >
              <div className="avatar-reference-heading">
                <span>
                  {t('Imágenes de referencia')} <small>{t('(opcional)')}</small>
                </span>
                {references.length > 0 && references.length < 3 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    tooltip={t('Añadir referencia')}
                    disabled={busy}
                    onClick={() => referenceInput.current?.click()}
                  >
                    <ImagePlus />
                  </Button>
                )}
              </div>
              <input
                ref={referenceInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                aria-label={t('Añadir imágenes de referencia')}
                className="sr-only"
                tabIndex={-1}
                disabled={busy}
                onChange={(event) => {
                  if (event.target.files) addReferences(event.target.files);
                  event.target.value = '';
                }}
              />
              {references.length ? (
                <div className="avatar-reference-strip">
                  {references.map((image, index) => (
                    <div className="avatar-reference-preview" key={image + index}>
                      <img src={image} alt={t('Referencia {number}', { number: index + 1 })} />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon-sm"
                        className="avatar-reference-remove"
                        tooltip={t('Quitar referencia {number}', { number: index + 1 })}
                        disabled={busy}
                        onClick={() =>
                          setReferences((previous) => previous.filter((_, i) => i !== index))
                        }
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  className="avatar-reference-dropzone"
                  disabled={busy}
                  onClick={() => referenceInput.current?.click()}
                >
                  <ImagePlus aria-hidden="true" />
                  <span>{t('Añade, arrastra o pega imágenes')}</span>
                </button>
              )}
              <small className="avatar-reference-hint">
                {t('Hasta 3 imágenes · PNG, JPEG o WebP · 5 MB por archivo')}
              </small>
            </div>
            <DialogFooter>
              <Button
                type="submit"
                size="icon"
                tooltip={t('Generar avatar')}
                disabled={busy || !prompt.trim()}
              >
                <Sparkles />
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
