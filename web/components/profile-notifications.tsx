'use client';
import { useState } from 'react';
import type { Profile } from '../lib/api';
import { CheckField, Field, SelectField } from './settings-fields';
import { HAEntityPicker } from './ha-entity-picker';

export function ProfileNotifications({ profile }: { profile: Profile }) {
  const [reset, setReset] = useState(profile.notifications?.reset?.enabled || false);
  const [mode, setMode] = useState(profile.notifications?.morning.mode || 'off');
  if (profile.notificationsMigrationPending)
    return (
      <section>
        <h3>Resumen de la mañana</h3>
        <p>
          La automatización existente sigue activa. No se ha podido importar su entidad desde Home
          Assistant. Comprueba su conexión y recarga el perfil en un minuto para editarla aquí.
        </p>
      </section>
    );
  return (
    <section className="provider-settings">
      {profile.source !== 'home_assistant' ? (
        <>
          <h3>Agenda y resumen de la mañana</h3>
          <p className="settings-help">
            Se envían a este perfil. Los perfiles nuevos los tienen desactivados.
          </p>
          <CheckField
            id="profile-event-reminders"
            name="eventReminders"
            label="Recordatorios de eventos"
            defaultChecked={profile.notifications?.eventReminders || false}
          />
          <p className="settings-help">
            Con Google Calendar conectado y su permiso activo, revisa la agenda cada 15 minutos y
            avisa de los eventos de los próximos 15 minutos.
          </p>
          <div className="settings-grid">
            <SelectField
              id="profile-morning-mode"
              name="morningMode"
              label="Resumen de la mañana"
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="off">Desactivado</option>
              <option value="time">A una hora</option>
              <option value="entity" disabled={!profile.hasHomeAssistant}>
                Al cambiar una entidad de Home Assistant
              </option>
            </SelectField>
            {mode === 'time' ? (
              <Field
                id="profile-morning-time"
                name="morningTime"
                label="Hora del resumen"
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
              Usa la zona horaria de este perfil. Incluye la agenda, tareas y previsión que tenga
              configuradas.
            </p>
          )}
          {mode === 'entity' && (
            <>
              <div className="settings-grid">
                <HAEntityPicker
                  profile={profile}
                  id="profile-morning-entity"
                  name="morningEntity"
                  label="Entidad de despertar"
                  domains="sensor,binary_sensor,input_boolean"
                  defaultValue={profile.notifications?.morning.entity || ''}
                />
                <Field
                  id="profile-morning-state"
                  name="morningState"
                  label="Estado que activa el resumen"
                  required
                  defaultValue={profile.notifications?.morning.state || 'off'}
                  placeholder="off"
                />
              </div>
              <p className="settings-help">
                Home Assistant avisa cuando la entidad coincide con este estado. Envía como máximo
                un resumen por día. El resumen sigue estos cambios mientras Zero está conectado; no
                recupera despertares anteriores.
              </p>
            </>
          )}
        </>
      ) : (
        <p className="settings-help">
          Los recordatorios y el resumen están disponibles en perfiles con Telegram.
        </p>
      )}
      <h3>Nueva sesión diaria</h3>
      <CheckField
        id="profile-daily-reset"
        name="dailyReset"
        label="Reiniciar la conversación cada día"
        checked={reset}
        onCheckedChange={(value) => setReset(value === true)}
      />
      {reset ? (
        <Field
          id="profile-reset-time"
          name="dailyResetTime"
          label="Hora de la nueva sesión"
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
        Usa la zona horaria del perfil. Limpia el contexto de la conversación y conserva la memoria
        a largo plazo.
      </p>
    </section>
  );
}
