'use client';
import { useTranslations } from '../i18n/provider';
import { type Profile } from '../lib/api';
import { HAEntityPicker } from './ha-entity-picker';

export function HATaskListPicker({ profile }: { profile: Profile }) {
  const t = useTranslations();
  return (
    <div className="settings-section">
      <HAEntityPicker
        profile={profile}
        id="profile-ha-task-list"
        name="ha-taskListEntity"
        label={t('Lista de tareas de Home Assistant')}
        domains="todo"
        pattern="todo\.[a-z0-9_]+"
        defaultValue={profile.homeAssistant?.taskListEntity || ''}
      />
    </div>
  );
}
