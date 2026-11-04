'use client';
import { useTranslations } from '../i18n/provider';
import { Tooltip } from 'radix-ui';
import { HomeAssistantIcon } from './home-assistant-icon';

export function HomeAssistantIndicator() {
  const t = useTranslations();
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            className="home-assistant-indicator"
            role="img"
            aria-label={t('Usuario de Home Assistant')}
            tabIndex={0}
          >
            <HomeAssistantIcon aria-hidden="true" />
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content sideOffset={6} className="action-tooltip">
            {t('Usuario de Home Assistant')}
            <Tooltip.Arrow />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
