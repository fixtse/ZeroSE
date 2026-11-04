'use client';
import { useTranslations } from '../i18n/provider';
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
  const t = useTranslations();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          className="quiet danger"
          disabled={disabled}
          size="icon"
          tooltip={t('Revocar')}
        >
          <Check />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('¿Revocar esta conexión?')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('Home Assistant dejará de conectarse con el token «')}
            {name}
            {t('». Puedes crear una nueva conexión cuando lo necesites.')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
          <AlertDialogAction onClick={onRevoke}>{t('Revocar token')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
