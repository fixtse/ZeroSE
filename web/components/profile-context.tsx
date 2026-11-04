'use client';
import { notify as setNotice, notifyError } from '../lib/notifications';
import { Save } from 'lucide-react';
import { useState } from 'react';
import { api, type Profile } from '../lib/api';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';

export function ProfileContext({ profile }: { profile: Profile }) {
  const [text, setText] = useState(profile.context || '');
  const [revision, setRevision] = useState(profile.contextRevision || 0);
  const [busy, setBusy] = useState(false);
  return (
    <section className="settings-section">
      <h3>Contexto · {profile.kind === 'group' ? 'grupo' : 'usuario'}</h3>
      <p>
        Este texto se añade automáticamente a las instrucciones cuando existe. El asistente puede
        editarlo con context_save.
      </p>
      <Label htmlFor="profile-context">Contexto</Label>
      <Textarea
        id="profile-context"
        value={text}
        rows={10}
        maxLength={16000}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="form-actions">
        <Button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const saved = await api<{ revision: number }>(
                '/v1/admin/profiles/' +
                  profile.bot +
                  '/' +
                  encodeURIComponent(profile.chatId) +
                  '/context',
                'PUT',
                { memory: text, revision },
              );
              setRevision(saved.revision);
              setNotice('Contexto guardado.');
            } catch (error) {
              notifyError(error instanceof Error ? error.message : 'No se pudo guardar.');
            } finally {
              setBusy(false);
            }
          }}
          size="icon"
          tooltip="Guardar contexto"
        >
          <Save />
        </Button>
      </div>
    </section>
  );
}
