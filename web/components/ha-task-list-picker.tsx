'use client';
import { type Profile } from '../lib/api';
import { HAEntityPicker } from './ha-entity-picker';

export function HATaskListPicker({ profile }: { profile: Profile }) {
  return (
    <div className="settings-section">
      <HAEntityPicker
        profile={profile}
        id="profile-ha-task-list"
        name="ha-taskListEntity"
        label="Lista de tareas de Home Assistant"
        domains="todo"
        pattern="todo\.[a-z0-9_]+"
        defaultValue={profile.homeAssistant?.taskListEntity || ''}
      />
    </div>
  );
}
