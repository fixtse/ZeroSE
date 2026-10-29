'use client';

import { Unlink } from 'lucide-react';
import type { Settings } from '../lib/api';
import { AssistantAvatar } from './assistant-image';
import { Card } from './ui/card';
import { Button } from './ui/button';
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

export function HomeAssistantUsers({
  settings,
  busy,
  onEdit,
  onUnlink,
}: {
  settings: Settings;
  busy: boolean;
  onEdit: (route: string) => void;
  onUnlink: (userId: string) => void;
}) {
  return (
    <Card className="panel">
      <h2>Usuarios de Home Assistant</h2>
      <p>Cada usuario utiliza los permisos y la memoria de su perfil vinculado en Zero.</p>
      <div className="people-list">
        {(settings.homeAssistantUserProfiles || []).map((user) => (
          <div className="ha-user-row" key={user.userId}>
            <div className="ha-user-summary">
              {user.profileRoute && user.assistantId && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="ha-user-avatar"
                  tooltip={'Editar perfil de ' + user.profileName}
                  aria-label={'Editar perfil de ' + user.profileName}
                  onClick={() => onEdit(user.profileRoute!)}
                >
                  <span className="assistant-avatar">
                    <AssistantAvatar id={user.assistantId} />
                  </span>
                </Button>
              )}
              <div className="person-details break-words">
                <strong>{user.userName}</strong>
              </div>
            </div>
            <div className="person-actions">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    disabled={busy}
                    tooltip="Desvincular usuario"
                    aria-label={'Desvincular ' + user.userName + ' de ' + user.profileName}
                  >
                    <Unlink />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>¿Desvincular {user.userName}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Este usuario dejará de utilizar el perfil {user.profileName} desde Home
                      Assistant. El perfil y su memoria se conservarán.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => onUnlink(user.userId)}>
                      Desvincular
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ))}
      </div>
      {!settings.homeAssistantUserProfiles?.length && <p>No hay usuarios vinculados.</p>}
      <p>
        Para vincular un usuario, aprueba la configuración desde Home Assistant. También puedes
        gestionar los vínculos en las opciones de la integración.
      </p>
    </Card>
  );
}
