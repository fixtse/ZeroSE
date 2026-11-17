# ZeroSE add-on

Your personal assistant for Telegram and Home Assistant. Chat with Zero, ask about
your home, and set reminders—all from one assistant.

## Set up Zero

1. **Add the repository** using the button below, then install **ZeroSE** from the
   Home Assistant add-on store.
2. **Start the add-on.** Keep the default settings: PGlite saves your data locally,
   so you do not need a separate database or a database URL.
3. **Open Web UI** while signed in to Home Assistant as an administrator.
4. **Follow the setup wizard.** Choose Telegram, Home Assistant, or both. Connect
   an AI provider and follow the steps for your chosen channel. Optional steps can
   be skipped and completed later.

[![Add the ZeroSE add-on repository to your Home Assistant.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Ffixtse%2FZeroSE)

## Start using Zero

- **Telegram:** message your bot, then approve your chat in **Users** in Zero.
- **Home Assistant:** install the [ZeroSE integration](https://github.com/fixtse/ha-zero-assistant)
  through HACS, follow the pairing steps, and choose **Zero** as your conversation
  agent in Assist. The integration is installed separately from this add-on.
- **Make it yours:** open Zero to adjust your assistant, permissions and memory,
  or connect optional services such as Google Calendar.

Try “Remind me in 30 minutes to check the oven” or, after connecting Home Assistant,
“What is the temperature at home?”

## Your data

PGlite is the default for new installations. If you already use PostgreSQL, keep
those settings: changing the database option does not transfer your existing data.

Back up the add-on before making changes. Stop it before copying its data files,
and keep the complete `/data/zero` folder together when backing up or restoring.
For an external PostgreSQL database, back up that database too.

For advanced database options, see the [technical guide](../../docs/technical-guide.md#optional-embedded-pglite).
