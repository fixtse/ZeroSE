'use client';
import { Tooltip } from 'radix-ui';
import { HomeAssistantIcon } from './home-assistant-icon';

export function HomeAssistantIndicator() {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            className="home-assistant-indicator"
            role="img"
            aria-label="Usuario de Home Assistant"
            tabIndex={0}
          >
            <HomeAssistantIcon aria-hidden="true" />
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content sideOffset={6} className="action-tooltip">
            Usuario de Home Assistant
            <Tooltip.Arrow />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
