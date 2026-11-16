'use client';
import { adminPath } from '../lib/admin-path';
import { type Profile } from '../lib/api';
import { useProfilePhoto } from '../hooks/use-cached-image';

export function TelegramAvatar({ profile }: { profile: Profile }) {
  const image = useProfilePhoto(profile.bot, profile.chatId);
  return (
    <span className="avatar">
      {image ? (
        <img
          src={adminPath(image)}
          alt=""
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}
        />
      ) : (
        profile.label.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
