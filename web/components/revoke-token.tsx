'use client';
import { Check } from 'lucide-react';
import { Button } from './ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './ui/alert-dialog';
export function RevokeToken({
  name,
  disabled,
  onRevoke,
}: {
  name: string;
  disabled: boolean;
  onRevoke: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          className="quiet danger"
          disabled={disabled}
          size="icon"
          tooltip="Revocar"
        >
          <Check />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Revocar esta conexión?</AlertDialogTitle>
          <AlertDialogDescription>
            Home Assistant dejará de conectarse con el token «{name}». Puedes crear una nueva
            conexión cuando lo necesites.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onRevoke}>Revocar token</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
