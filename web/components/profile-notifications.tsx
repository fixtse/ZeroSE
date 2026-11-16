'use client';
import { useTranslations } from '../i18n/provider';
import { useEffect, useState } from 'react';
import { api, type Profile } from '../lib/api';
import { CheckField, Field, SelectField } from './settings-fields';
import { HAEntityPicker } from './ha-entity-picker';

export function ProfileNotifications({ profile }: { profile: Profile }) {
  const t = useTranslations();
  const [weather, setWeather] = useState(profile.notifications?.weather?.mode || 'off');
  const [events, setEvents] = useState(profile.notifications?.eventReminders || false);
  const [reset, setReset] = useState(profile.notifications?.reset?.enabled || false);
  const [mode, setMode] = useState(profile.notifications?.morning.mode || 'off');
  const [weatherState, setWeatherState] = useState('checking');
  const savedWeatherMode = profile.notifications?.weather?.mode || 'off';
  useEffect(() => {
    if (savedWeatherMode === 'off' || profile.source === 'home_assistant') return;
    const controller = new AbortController();
    let running = false;
    setWeatherState('checking');
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const status = await api<{ state: string }>(
          '/v1/admin/profiles/' +
            profile.bot +
            '/' +
            encodeURIComponent(profile.chatId) +
            '/weather-status',
          'GET',
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) setWeatherState(status.state);
      } catch {
        if (!controller.signal.aborted) setWeatherState('unavailable');
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [profile.bot, profile.chatId, profile.source, savedWeatherMode]);
  if (profile.notificationsMigrationPending)
    return (
      <section>
        <h3>{t('Resumen de la mañana')}</h3>
        <p>
          {t(
            'La automatización existente sigue activa. No se ha podido importar su entidad desde Home Assistant. Comprueba su conexión y recarga el perfil en un minuto para editarla aquí.',
          )}
        </p>
      </section>
    );
  return (
    <section className="provider-settings">
      {profile.source !== 'home_assistant' ? (
        <>
          <h3>{t('Avisos del tiempo')}</h3>
          <SelectField
            id="profile-weather-mode"
            name="weatherMode"
            label={t('Notificaciones meteorológicas')}
            value={weather}
            onChange={(event) => setWeather(event.target.value as typeof weather)}
          >
            <option value="off">{t('Desactivado')}</option>
            <option value="important" disabled={!profile.hasHomeAssistant}>
              {t('Solo tiempo importante')}
            </option>
            <option value="updates" disabled={!profile.hasHomeAssistant}>
              {t('Tiempo importante y actualizaciones ocasionales')}
            </option>
            <option value="all" disabled={!profile.hasHomeAssistant}>
              {t('Todos los cambios')}
            </option>
          </SelectField>
          {savedWeatherMode !== 'off' && (
            <p
              role={['active', 'muted', 'checking'].includes(weatherState) ? 'status' : 'alert'}
              className={
                ['active', 'muted', 'checking'].includes(weatherState)
                  ? 'settings-help'
                  : 'weather-subscription-warning'
              }
            >
              {t(
                weatherState === 'checking'
                  ? 'Comprobando los avisos en Home Assistant…'
                  : weatherState === 'active'
                    ? 'Avisos activos y confirmados en Home Assistant.'
                    : weatherState === 'muted'
                      ? 'Avisos activos. Silenciados temporalmente mientras duermes.'
                      : weatherState === 'paused'
                        ? 'Los avisos están activados en tus preferencias, pero Home Assistant los ha pausado. No recibirás avisos. Guarda el perfil para intentar reactivarlos.'
                        : 'No se puede confirmar que los avisos estén activos en Home Assistant. Comprueba su conexión y guarda el perfil. No se ha reintentado ningún cambio incierto.',
              )}
            </p>
          )}
          <p className="settings-help">
            {t(
              'Avisa de nueva lluvia, tormentas, nieve, granizo, niebla, viento fuerte y temperaturas extremas. Agrupa revisiones del mismo episodio y avisa si empeora o empieza al menos una hora antes. La previsión corresponde a la zona configurada en Home Assistant.',
            )}
          </p>
          {weather === 'updates' && (
            <Field
              id="profile-weather-hours"
              name="weatherRoutineHours"
              label={t('Intervalo mínimo entre actualizaciones habituales (horas)')}
              type="number"
              min={1}
              max={24}
              step={1}
              required
              defaultValue={profile.notifications?.weather?.routineIntervalHours || 6}
            />
          )}
          <p className="settings-help">
            {t(
              'La lluvia y el tiempo importante no esperan este intervalo. Los cambios pequeños quedan para el resumen de la mañana, si está activado. Todos los cambios puede generar muchos avisos. Requiere Home Assistant.',
            )}
          </p>
          <h3>{t('Agenda y resumen de la mañana')}</h3>
          <p className="settings-help">
            {t('Se envían a este perfil. Los perfiles nuevos los tienen desactivados.')}
          </p>
          <CheckField
            id="profile-event-reminders"
            name="eventReminders"
            label={t('Recordatorios de eventos')}
            checked={events}
            onCheckedChange={(value) => setEvents(value === true)}
          />
          {events && (
            <Field
              id="profile-event-reminder-minutes"
              name="eventReminderMinutes"
              label={t('Antelación del aviso (minutos)')}
              type="number"
              min={1}
              max={1440}
              step={1}
              required
              defaultValue={profile.notifications?.eventReminderMinutes || 15}
            />
          )}
          <p className="settings-help">
            {t(
              'Revisa la agenda cada minuto y añade contexto relevante, recuerdos y previsión disponibles según los permisos del perfil.',
            )}
          </p>
          <div className="settings-grid">
            <SelectField
              id="profile-morning-mode"
              name="morningMode"
              label={t('Resumen de la mañana')}
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="off">{t('Desactivado')}</option>
              <option value="time">{t('A una hora')}</option>
              <option value="entity" disabled={!profile.hasHomeAssistant}>
                {t('Al cambiar una entidad de Home Assistant')}
              </option>
            </SelectField>
            {mode === 'time' ? (
              <Field
                id="profile-morning-time"
                name="morningTime"
                label={t('Hora del resumen')}
                type="time"
                required
                defaultValue={profile.notifications?.morning.time || '08:30'}
              />
            ) : (
              <input
                type="hidden"
                name="morningTime"
                value={profile.notifications?.morning.time || '08:30'}
              />
            )}
          </div>
          {mode === 'time' && (
            <p className="settings-help">
              {t(
                'Usa la zona horaria de este perfil. Incluye la agenda, tareas y previsión que tenga configuradas.',
              )}
            </p>
          )}
          {mode === 'entity' && (
            <>
              <div className="settings-grid">
                <HAEntityPicker
                  profile={profile}
                  id="profile-morning-entity"
                  name="morningEntity"
                  label={t('Entidad de despertar')}
                  domains="sensor,binary_sensor,input_boolean"
                  defaultValue={profile.notifications?.morning.entity || ''}
                />
                <Field
                  id="profile-morning-state"
                  name="morningState"
                  label={t('Estado que activa el resumen')}
                  required
                  defaultValue={profile.notifications?.morning.state || 'off'}
                  placeholder="off"
                />
              </div>
              <p className="settings-help">
                {t(
                  'Home Assistant avisa cuando la entidad coincide con este estado. Envía como máximo un resumen por día. El resumen sigue estos cambios mientras Zero está conectado; no recupera despertares anteriores.',
                )}
              </p>
            </>
          )}
        </>
      ) : (
        <p className="settings-help">
          {t('Los recordatorios y el resumen están disponibles en perfiles con Telegram.')}
        </p>
      )}
      <h3>{t('Nueva sesión diaria')}</h3>
      <CheckField
        id="profile-daily-reset"
        name="dailyReset"
        label={t('Reiniciar la conversación cada día')}
        checked={reset}
        onCheckedChange={(value) => setReset(value === true)}
      />
      {reset ? (
        <Field
          id="profile-reset-time"
          name="dailyResetTime"
          label={t('Hora de la nueva sesión')}
          type="time"
          required
          defaultValue={profile.notifications?.reset?.time || '04:00'}
        />
      ) : (
        <input
          type="hidden"
          name="dailyResetTime"
          value={profile.notifications?.reset?.time || '04:00'}
        />
      )}
      <p className="settings-help">
        {t(
          'Usa la zona horaria del perfil. Limpia el contexto de la conversación y conserva la memoria a largo plazo.',
        )}
      </p>
    </section>
  );
}
