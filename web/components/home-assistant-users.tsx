'use client';

import { Pencil, Unlink } from 'lucide-react';
import type { Settings } from '../lib/api';
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
          <div
            className="person-row flex flex-wrap items-center justify-between gap-4 border-b py-4"
            key={user.userId}
          >
            <div className="person-summary min-w-0 break-words">
              <strong>{user.userName}</strong>
              <p>Perfil de Zero: {user.profileName}</p>
            </div>
            <div className="person-actions">
              {user.profileRoute && (
                <Button
                  variant="outline"
                  size="icon"
                  tooltip="Editar perfil vinculado"
                  aria-label={'Editar perfil de ' + user.profileName}
                  onClick={() => onEdit(user.profileRoute!)}
                >
                  <Pencil />
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
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
