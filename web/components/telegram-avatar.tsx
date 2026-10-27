'use client';
import { adminPath } from '../lib/admin-path';
import { useEffect, useState } from 'react';
import { api, type Profile } from '../lib/api';
export function TelegramAvatar({ profile }: { profile: Profile }) {
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let active = true;
    setImage(undefined);
    void api<{ image?: string }>(
      '/v1/admin/profiles/' + profile.bot + '/' + encodeURIComponent(profile.chatId) + '/photo',
    )
      .then((result) => {
        if (active) setImage(result.image);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [profile.bot, profile.chatId, profile.kind]);
  return (
    <span className="avatar">
      {image ? (
        <img
          src={adminPath(image)}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}
        />
      ) : (
        profile.label.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
